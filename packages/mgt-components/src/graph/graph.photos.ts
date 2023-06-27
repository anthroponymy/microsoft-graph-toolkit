/**
 * -------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation.  All Rights Reserved.  Licensed under the MIT License.
 * See License in the project root for license information.
 * -------------------------------------------------------------------------------------------
 */

import { IGraph, prepScopes, CacheItem, CacheService, CacheStore } from '@microsoft/mgt-element';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import * as MicrosoftGraph from '@microsoft/microsoft-graph-types';
import { Person, ProfilePhoto } from '@microsoft/microsoft-graph-types';

import { blobToBase64 } from '../utils/Utils';
import { schemas } from './cacheStores';
import { findContactsByEmail, getEmailFromGraphEntity } from './graph.people';
import { findUsers } from './graph.user';
import { IDynamicPerson } from './types';

/**
 * photo object stored in cache
 */
export interface CachePhoto extends CacheItem {
  /**
   * user tag associated with photo
   */
  eTag?: string;
  /**
   * user/contact photo
   */
  photo?: string;
}

/**
 * Defines expiration time
 */
export const getPhotoInvalidationTime = () =>
  CacheService.config.photos.invalidationPeriod || CacheService.config.defaultInvalidationPeriod;

/**
 * Whether photo store is enabled
 */
export const getIsPhotosCacheEnabled = () => CacheService.config.photos.isEnabled && CacheService.config.isEnabled;

/**
 * retrieves a photo for the specified resource.
 *
 * @param {string} resource
 * @param {string[]} scopes
 * @returns {Promise<string>}
 */
export const getPhotoForResource = async (graph: IGraph, resource: string, scopes: string[]): Promise<CachePhoto> => {
  try {
    const response = (await graph
      .api(`${resource}/photo/$value`)
      .responseType(ResponseType.RAW)
      .middlewareOptions(prepScopes(...scopes))
      .get()) as Response;

    if (response.status === 404) {
      // 404 means the resource does not have a photo
      // we still want to cache that state
      // so we return an object that can be cached
      return { eTag: null, photo: null };
    } else if (!response.ok) {
      return null;
    }

    const eTag = response['@odata.mediaEtag'] as string;
    const blob = await blobToBase64(await response.blob());
    return { eTag, photo: blob };
  } catch (e) {
    return null;
  }
};

/**
 * async promise, returns Graph photos associated with contacts of the logged in user
 *
 * @param contactId
 * @returns {Promise<string>}
 * @memberof Graph
 */
export const getContactPhoto = async (graph: IGraph, contactId: string): Promise<string> => {
  let cache: CacheStore<CachePhoto>;
  let photoDetails: CachePhoto;
  if (getIsPhotosCacheEnabled()) {
    cache = CacheService.getCache<CachePhoto>(schemas.photos, schemas.photos.stores.contacts);
    photoDetails = await cache.getValue(contactId);
    if (photoDetails && getPhotoInvalidationTime() > Date.now() - photoDetails.timeCached) {
      return photoDetails.photo;
    }
  }

  photoDetails = await getPhotoForResource(graph, `me/contacts/${contactId}`, ['contacts.read']);
  if (getIsPhotosCacheEnabled() && photoDetails) {
    await cache.putValue(contactId, photoDetails);
  }
  return photoDetails ? photoDetails.photo : null;
};

/**
 * async promise, returns Graph photo associated with provided userId
 *
 * @param userId
 * @returns {Promise<string>}
 * @memberof Graph
 */
export const getUserPhoto = async (graph: IGraph, userId: string): Promise<string> => {
  let cache: CacheStore<CachePhoto>;
  let photoDetails: CachePhoto;

  if (getIsPhotosCacheEnabled()) {
    cache = CacheService.getCache<CachePhoto>(schemas.photos, schemas.photos.stores.users);
    photoDetails = await cache.getValue(userId);
    if (photoDetails && getPhotoInvalidationTime() > Date.now() - photoDetails.timeCached) {
      return photoDetails.photo;
    } else if (photoDetails) {
      // there is a photo in the cache, but it's staleS
      try {
        const response = (await graph.api(`users/${userId}/photo`).get()) as ProfilePhoto;
        if (
          response &&
          (response['@odata.mediaEtag'] !== photoDetails.eTag ||
            (response['@odata.mediaEtag'] === null && photoDetails.eTag === null))
        ) {
          // set photoDetails to null so that photo gets pulled from the graph later
          photoDetails = null;
        }
      } catch {
        return null;
      }
    }
  }

  // if there is a photo in the cache, we got here because it was stale
  photoDetails = photoDetails || (await getPhotoForResource(graph, `users/${userId}`, ['user.readbasic.all']));
  if (getIsPhotosCacheEnabled() && photoDetails) {
    await cache.putValue(userId, photoDetails);
  }
  return photoDetails ? photoDetails.photo : null;
};

/**
 * async promise, returns Graph photo associated with the logged in user
 *
 * @returns {Promise<string>}
 * @memberof Graph
 */
export const myPhoto = async (graph: IGraph): Promise<string> => {
  let cache: CacheStore<CachePhoto>;
  let photoDetails: CachePhoto;
  if (getIsPhotosCacheEnabled()) {
    cache = CacheService.getCache<CachePhoto>(schemas.photos, schemas.photos.stores.users);
    photoDetails = await cache.getValue('me');
    if (photoDetails && getPhotoInvalidationTime() > Date.now() - photoDetails.timeCached) {
      return photoDetails.photo;
    }
  }

  try {
    const response = (await graph.api('me/photo').get()) as ProfilePhoto;
    if (
      response &&
      (response['@odata.mediaEtag'] !== photoDetails.eTag ||
        (response['@odata.mediaEtag'] === null && photoDetails.eTag === null))
    ) {
      photoDetails = null;
    }
  } catch {
    return null;
  }

  photoDetails = photoDetails || (await getPhotoForResource(graph, 'me', ['user.read']));
  if (getIsPhotosCacheEnabled()) {
    await cache.putValue('me', photoDetails || {});
  }

  return photoDetails ? photoDetails.photo : null;
};

/**
 * async promise, loads image of user
 *
 * @export
 */
export const getPersonImage = async (graph: IGraph, person: IDynamicPerson, useContactsApis = true) => {
  // handle if person but not user
  if ('personType' in person && (person as Person).personType.subclass !== 'OrganizationUser') {
    if ((person as Person).personType.subclass === 'PersonalContact' && useContactsApis) {
      // if person is a contact, look for them and their photo in contact api
      const contactMail = getEmailFromGraphEntity(person);
      const contact = await findContactsByEmail(graph, contactMail);
      if (contact?.length && contact[0].id) {
        return await getContactPhoto(graph, contact[0].id);
      }
    }

    return null;
  }

  // handle if user
  if ((person as MicrosoftGraph.Person).userPrincipalName || person.id) {
    // try to find a user by userPrincipalName
    const id = (person as MicrosoftGraph.Person).userPrincipalName || person.id;
    return await getUserPhoto(graph, id);
  }

  // else assume id is for user and try to get photo
  if (person.id) {
    const image = await getUserPhoto(graph, person.id);
    if (image) {
      return image;
    }
  }

  // let's try to find a person by the email
  const email = getEmailFromGraphEntity(person);

  if (email) {
    // try to find user
    const users = await findUsers(graph, email, 1);
    if (users?.length) {
      return await getUserPhoto(graph, users[0].id);
    }

    // if no user, try to find a contact
    if (useContactsApis) {
      const contacts = await findContactsByEmail(graph, email);
      if (contacts?.length) {
        return await getContactPhoto(graph, contacts[0].id);
      }
    }
  }

  return null;
};

/**
 * Load the image for a group
 *
 * @param graph
 * @param group
 * @param useContactsApis
 * @returns
 */
export const getGroupImage = async (graph: IGraph, group: IDynamicPerson, useContactsApis = true) => {
  let photoDetails: CachePhoto;
  let cache: CacheStore<CachePhoto>;

  const groupId = group.id;

  if (getIsPhotosCacheEnabled()) {
    cache = CacheService.getCache<CachePhoto>(schemas.photos, schemas.photos.stores.groups);
    photoDetails = await cache.getValue(groupId);
    if (photoDetails && getPhotoInvalidationTime() > Date.now() - photoDetails.timeCached) {
      return photoDetails.photo;
    } else if (photoDetails) {
      // there is a photo in the cache, but it's stale
      try {
        const response = (await graph.api(`groups/${groupId}/photo`).get()) as ProfilePhoto;
        if (
          response &&
          (response['@odata.mediaEtag'] !== photoDetails.eTag ||
            (response['@odata.mediaEtag'] === null && photoDetails.eTag === null))
        ) {
          // set photoDetails to null so that photo gets pulled from the graph later
          photoDetails = null;
        }
      } catch {
        return null;
      }
    }
  }

  // if there is a photo in the cache, we got here because it was stale
  photoDetails = photoDetails || (await getPhotoForResource(graph, `groups/${groupId}`, ['user.readbasic.all']));
  if (getIsPhotosCacheEnabled() && photoDetails) {
    await cache.putValue(groupId, photoDetails);
  }
  return photoDetails ? photoDetails.photo : null;
};

/**
 * checks if user has a photo in the cache
 *
 * @param userId
 * @returns {CachePhoto}
 * @memberof Graph
 */
export const getPhotoFromCache = async (userId: string, storeName: string): Promise<CachePhoto> => {
  const cache = CacheService.getCache<CachePhoto>(schemas.photos, storeName);
  const item = await cache.getValue(userId);
  return item;
};

/**
 * checks if user has a photo in the cache
 *
 * @param userId
 * @returns {void}
 * @memberof Graph
 */
export const storePhotoInCache = async (userId: string, storeName: string, value: CachePhoto): Promise<void> => {
  const cache = CacheService.getCache<CachePhoto>(schemas.photos, storeName);
  await cache.putValue(userId, value);
};
