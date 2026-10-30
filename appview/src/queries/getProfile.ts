import type { IdResolver } from '@atproto/identity'
import type { Db } from '../db.js'
import { hydrateHandle } from './hydrateActor.js'
import { isLive } from '../pushRegistry.js'

export interface GetProfileParams {
  did: string
  // Public PDS base URL; used to build the avatar blob pointer.
  pdsUrl: string
}

export interface ProfileView {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  postsCount: number
  followersCount: number
  followsCount: number
  live: boolean
  indexedAt?: string
}

interface ProfileRow {
  displayName: string | null
  description: string | null
  avatarCid: string | null
  indexedAt: string
}

// Returns the assembled profileView. A resolvable actor with no
// `ait.actor.profile` record still returns a view: handle + counts, with the
// optional displayName/description/avatar simply absent.
export async function getProfile(
  db: Db,
  idResolver: IdResolver,
  params: GetProfileParams,
): Promise<ProfileView> {
  const { did, pdsUrl } = params

  // Peer display names remain readable from verified projection while their
  // source is offline or Unlinked. Local names retain strict DID hydration.
  const handle = await hydrateHandle(idResolver, did, db)

  const profile = db
    .prepare(
      `SELECT displayName, description, avatarCid, indexedAt
       FROM profiles WHERE did = ?`,
    )
    .get(did) as ProfileRow | undefined

  // Counts come straight from COUNT(*) — no denormalized counter for v1.
  const postsCount = countRows(db, 'SELECT COUNT(*) AS c FROM posts WHERE did = ?', did)
  const followersCount = countRows(db, 'SELECT COUNT(*) AS c FROM follows WHERE subject = ?', did)
  const followsCount = countRows(db, 'SELECT COUNT(*) AS c FROM follows WHERE did = ?', did)

  const view: ProfileView = {
    did,
    handle,
    postsCount,
    followersCount,
    followsCount,
    live: isLive(did),
  }
  if (profile) {
    if (profile.displayName) view.displayName = profile.displayName
    if (profile.description) view.description = profile.description
    if (profile.avatarCid) view.avatar = blobUrl(pdsUrl, did, profile.avatarCid)
    view.indexedAt = profile.indexedAt
  }
  return view
}

function countRows(db: Db, sql: string, did: string): number {
  const row = db.prepare(sql).get(did) as { c: number }
  return row.c
}

// Avatars are served raw through the PDS for v1 — the AppView just hands back
// a getBlob pointer; no CDN, no thumbnailing (specs/profile.md).
function blobUrl(pdsUrl: string, did: string, cid: string): string {
  const params = new URLSearchParams({ did, cid })
  return `${pdsUrl}/xrpc/com.atproto.sync.getBlob?${params.toString()}`
}
