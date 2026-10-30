import { AtUri } from '@atproto/syntax'
import type { Db } from '../db.js'
import { resolveActorToDid } from './resolveHandle.js'

export interface GetRecordParams {
  repo: string
  collection: string
  rkey: string
  cid?: string
}

export interface GetRecordResult {
  uri: string
  cid: string
  value: Record<string, unknown>
}

// com.atproto.repo.getRecord's shape for complete projected posts. The HTTP
// boundary maps null to RecordNotFound. Never synthesize a legacy partial row.
export async function getRecord(db: Db, params: GetRecordParams): Promise<GetRecordResult | null> {
  if (params.collection !== 'ait.feed.post') return null
  const did = await resolveActorToDid(db, params.repo)
  if (!did) return null
  const uri = AtUri.make(did, params.collection, params.rkey).toString()
  const row = db.prepare('SELECT uri, cid, recordJson FROM posts WHERE uri = ?').get(uri) as
    { uri: string; cid: string; recordJson: string | null } | undefined
  if (!row || row.recordJson === null || (params.cid !== undefined && row.cid !== params.cid)) {
    return null
  }
  return { uri: row.uri, cid: row.cid, value: JSON.parse(row.recordJson) }
}
