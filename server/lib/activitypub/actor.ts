import * as Bluebird from 'bluebird'
import { join } from 'path'
import { Transaction } from 'sequelize'
import * as url from 'url'
import * as uuidv4 from 'uuid/v4'
import { ActivityPubActor, ActivityPubActorType } from '../../../shared/models/activitypub'
import { ActivityPubAttributedTo } from '../../../shared/models/activitypub/objects'
import { isActorObjectValid } from '../../helpers/custom-validators/activitypub/actor'
import { isActivityPubUrlValid } from '../../helpers/custom-validators/activitypub/misc'
import { retryTransactionWrapper, updateInstanceWithAnother } from '../../helpers/database-utils'
import { logger } from '../../helpers/logger'
import { createPrivateAndPublicKeys } from '../../helpers/peertube-crypto'
import { doRequest, doRequestAndSaveToFile } from '../../helpers/requests'
import { getUrlFromWebfinger } from '../../helpers/webfinger'
import { AVATAR_MIMETYPE_EXT, CONFIG, sequelizeTypescript } from '../../initializers'
import { AccountModel } from '../../models/account/account'
import { ActorModel } from '../../models/activitypub/actor'
import { AvatarModel } from '../../models/avatar/avatar'
import { ServerModel } from '../../models/server/server'
import { VideoChannelModel } from '../../models/video/video-channel'

// Set account keys, this could be long so process after the account creation and do not block the client
function setAsyncActorKeys (actor: ActorModel) {
  return createPrivateAndPublicKeys()
    .then(({ publicKey, privateKey }) => {
      actor.set('publicKey', publicKey)
      actor.set('privateKey', privateKey)
      return actor.save()
    })
    .catch(err => {
      logger.error('Cannot set public/private keys of actor %d.', actor.uuid, err)
      return actor
    })
}

async function getOrCreateActorAndServerAndModel (actorUrl: string, recurseIfNeeded = true) {
  let actor = await ActorModel.loadByUrl(actorUrl)

  // We don't have this actor in our database, fetch it on remote
  if (!actor) {
    const result = await fetchRemoteActor(actorUrl)
    if (result === undefined) throw new Error('Cannot fetch remote actor.')

    // Create the attributed to actor
    // In PeerTube a video channel is owned by an account
    let ownerActor: ActorModel = undefined
    if (recurseIfNeeded === true && result.actor.type === 'Group') {
      const accountAttributedTo = result.attributedTo.find(a => a.type === 'Person')
      if (!accountAttributedTo) throw new Error('Cannot find account attributed to video channel ' + actor.url)

      try {
        // Assert we don't recurse another time
        ownerActor = await getOrCreateActorAndServerAndModel(accountAttributedTo.id, false)
      } catch (err) {
        logger.error('Cannot get or create account attributed to video channel ' + actor.url)
        throw new Error(err)
      }
    }

    const options = {
      arguments: [ result, ownerActor ],
      errorMessage: 'Cannot save actor and server with many retries.'
    }
    actor = await retryTransactionWrapper(saveActorAndServerAndModelIfNotExist, options)
  }

  return refreshActorIfNeeded(actor)
}

function buildActorInstance (type: ActivityPubActorType, url: string, preferredUsername: string, uuid?: string) {
  return new ActorModel({
    type,
    url,
    preferredUsername,
    uuid,
    publicKey: null,
    privateKey: null,
    followersCount: 0,
    followingCount: 0,
    inboxUrl: url + '/inbox',
    outboxUrl: url + '/outbox',
    sharedInboxUrl: CONFIG.WEBSERVER.URL + '/inbox',
    followersUrl: url + '/followers',
    followingUrl: url + '/following'
  })
}

async function updateActorInstance (actorInstance: ActorModel, attributes: ActivityPubActor) {
  const followersCount = await fetchActorTotalItems(attributes.followers)
  const followingCount = await fetchActorTotalItems(attributes.following)

  actorInstance.set('type', attributes.type)
  actorInstance.set('uuid', attributes.uuid)
  actorInstance.set('preferredUsername', attributes.preferredUsername)
  actorInstance.set('url', attributes.id)
  actorInstance.set('publicKey', attributes.publicKey.publicKeyPem)
  actorInstance.set('followersCount', followersCount)
  actorInstance.set('followingCount', followingCount)
  actorInstance.set('inboxUrl', attributes.inbox)
  actorInstance.set('outboxUrl', attributes.outbox)
  actorInstance.set('sharedInboxUrl', attributes.endpoints.sharedInbox)
  actorInstance.set('followersUrl', attributes.followers)
  actorInstance.set('followingUrl', attributes.following)
}

async function updateActorAvatarInstance (actorInstance: ActorModel, avatarName: string, t: Transaction) {
  if (avatarName !== undefined) {
    if (actorInstance.avatarId) {
      try {
        await actorInstance.Avatar.destroy({ transaction: t })
      } catch (err) {
        logger.error('Cannot remove old avatar of actor %s.', actorInstance.url, err)
      }
    }

    const avatar = await AvatarModel.create({
      filename: avatarName
    }, { transaction: t })

    actorInstance.set('avatarId', avatar.id)
    actorInstance.Avatar = avatar
  }

  return actorInstance
}

async function fetchActorTotalItems (url: string) {
  const options = {
    uri: url,
    method: 'GET',
    json: true,
    activityPub: true
  }

  let requestResult
  try {
    requestResult = await doRequest(options)
  } catch (err) {
    logger.warn('Cannot fetch remote actor count %s.', url, err)
    return undefined
  }

  return requestResult.totalItems ? requestResult.totalItems : 0
}

async function fetchAvatarIfExists (actorJSON: ActivityPubActor) {
  if (
    actorJSON.icon && actorJSON.icon.type === 'Image' && AVATAR_MIMETYPE_EXT[actorJSON.icon.mediaType] !== undefined &&
    isActivityPubUrlValid(actorJSON.icon.url)
  ) {
    const extension = AVATAR_MIMETYPE_EXT[actorJSON.icon.mediaType]

    const avatarName = uuidv4() + extension
    const destPath = join(CONFIG.STORAGE.AVATARS_DIR, avatarName)

    await doRequestAndSaveToFile({
      method: 'GET',
      uri: actorJSON.icon.url
    }, destPath)

    return avatarName
  }

  return undefined
}

export {
  getOrCreateActorAndServerAndModel,
  buildActorInstance,
  setAsyncActorKeys,
  fetchActorTotalItems,
  fetchAvatarIfExists,
  updateActorInstance,
  updateActorAvatarInstance
}

// ---------------------------------------------------------------------------

function saveActorAndServerAndModelIfNotExist (
  result: FetchRemoteActorResult,
  ownerActor?: ActorModel,
  t?: Transaction
): Bluebird<ActorModel> | Promise<ActorModel> {
  let actor = result.actor

  if (t !== undefined) return save(t)

  return sequelizeTypescript.transaction(t => save(t))

  async function save (t: Transaction) {
    const actorHost = url.parse(actor.url).host

    const serverOptions = {
      where: {
        host: actorHost
      },
      defaults: {
        host: actorHost
      },
      transaction: t
    }
    const [ server ] = await ServerModel.findOrCreate(serverOptions)

    // Save our new account in database
    actor.set('serverId', server.id)

    // Avatar?
    if (result.avatarName) {
      const avatar = await AvatarModel.create({
        filename: result.avatarName
      }, { transaction: t })
      actor.set('avatarId', avatar.id)
    }

    // Force the actor creation, sometimes Sequelize skips the save() when it thinks the instance already exists
    // (which could be false in a retried query)
    const actorCreated = await ActorModel.create(actor.toJSON(), { transaction: t })

    if (actorCreated.type === 'Person' || actorCreated.type === 'Application') {
      const account = await saveAccount(actorCreated, result, t)
      actorCreated.Account = account
      actorCreated.Account.Actor = actorCreated
    } else if (actorCreated.type === 'Group') { // Video channel
      const videoChannel = await saveVideoChannel(actorCreated, result, ownerActor, t)
      actorCreated.VideoChannel = videoChannel
      actorCreated.VideoChannel.Actor = actorCreated
    }

    return actorCreated
  }
}

type FetchRemoteActorResult = {
  actor: ActorModel
  name: string
  summary: string
  avatarName?: string
  attributedTo: ActivityPubAttributedTo[]
}
async function fetchRemoteActor (actorUrl: string): Promise<FetchRemoteActorResult> {
  const options = {
    uri: actorUrl,
    method: 'GET',
    json: true,
    activityPub: true
  }

  logger.info('Fetching remote actor %s.', actorUrl)

  const requestResult = await doRequest(options)
  const actorJSON: ActivityPubActor = requestResult.body

  if (isActorObjectValid(actorJSON) === false) {
    logger.debug('Remote actor JSON is not valid.', { actorJSON: actorJSON })
    return undefined
  }

  const followersCount = await fetchActorTotalItems(actorJSON.followers)
  const followingCount = await fetchActorTotalItems(actorJSON.following)

  const actor = new ActorModel({
    type: actorJSON.type,
    uuid: actorJSON.uuid,
    preferredUsername: actorJSON.preferredUsername,
    url: actorJSON.id,
    publicKey: actorJSON.publicKey.publicKeyPem,
    privateKey: null,
    followersCount: followersCount,
    followingCount: followingCount,
    inboxUrl: actorJSON.inbox,
    outboxUrl: actorJSON.outbox,
    sharedInboxUrl: actorJSON.endpoints.sharedInbox,
    followersUrl: actorJSON.followers,
    followingUrl: actorJSON.following
  })

  const avatarName = await fetchAvatarIfExists(actorJSON)

  const name = actorJSON.name || actorJSON.preferredUsername
  return {
    actor,
    name,
    avatarName,
    summary: actorJSON.summary,
    attributedTo: actorJSON.attributedTo
  }
}

function saveAccount (actor: ActorModel, result: FetchRemoteActorResult, t: Transaction) {
  const account = new AccountModel({
    name: result.name,
    actorId: actor.id
  })

  return account.save({ transaction: t })
}

async function saveVideoChannel (actor: ActorModel, result: FetchRemoteActorResult, ownerActor: ActorModel, t: Transaction) {
  const videoChannel = new VideoChannelModel({
    name: result.name,
    description: result.summary,
    actorId: actor.id,
    accountId: ownerActor.Account.id
  })

  return videoChannel.save({ transaction: t })
}

async function refreshActorIfNeeded (actor: ActorModel) {
  if (!actor.isOutdated()) return actor

  const actorUrl = await getUrlFromWebfinger(actor.preferredUsername, actor.getHost())
  const result = await fetchRemoteActor(actorUrl)
  if (result === undefined) throw new Error('Cannot fetch remote actor in refresh actor.')

  return sequelizeTypescript.transaction(async t => {
    updateInstanceWithAnother(actor, result.actor)

    if (result.avatarName !== undefined) {
      await updateActorAvatarInstance(actor, result.avatarName, t)
    }

    // Force update
    actor.setDataValue('updatedAt', new Date())
    await actor.save({ transaction: t })

    if (actor.Account) {
      await actor.save({ transaction: t })

      actor.Account.set('name', result.name)
      await actor.Account.save({ transaction: t })
    } else if (actor.VideoChannel) {
      await actor.save({ transaction: t })

      actor.VideoChannel.set('name', result.name)
      await actor.VideoChannel.save({ transaction: t })
    }

    return actor
  })
}