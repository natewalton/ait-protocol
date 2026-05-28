// One-shot backfill for posts rows that have replyRootUri / replyParentUri
// but no corresponding *Cid (pre-Fix-1 indexer behavior). Fetches each
// referenced post via the local PDS's com.atproto.repo.getRecord and writes
// the missing CIDs.
//
// Idempotent: skips posts that already have both CIDs (or aren't replies).
// Safe to run against a live AppView (WAL mode handles concurrent writes).
//
// Usage:  npx tsx scripts/backfill-reply-cids.ts

import 'dotenv/config'
import Database from 'better-sqlite3'
import { AtpAgent } from '@atproto/api'

const DB_PATH = process.env.APPVIEW_DB_PATH ?? './data/appview.sqlite'
const PDS_URL = process.env.APPVIEW_PDS_URL ?? 'http://localhost:2583'

interface Row {
  uri: string
  replyRootUri: string | null
  replyParentUri: string | null
  replyRootCid: string | null
  replyParentCid: string | null
}

function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } | null {
  if (!uri.startsWith('at://')) return null
  const rest = uri.slice('at://'.length)
  const [repo, collection, rkey] = rest.split('/')
  if (!repo || !collection || !rkey) return null
  return { repo, collection, rkey }
}

async function main() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  const rows = db
    .prepare(
      `SELECT uri, replyRootUri, replyParentUri, replyRootCid, replyParentCid
       FROM posts
       WHERE replyParentUri IS NOT NULL
         AND (replyParentCid IS NULL OR replyRootCid IS NULL)`,
    )
    .all() as Row[]

  console.log(`backfill: ${rows.length} reply posts with missing CIDs`)

  const agent = new AtpAgent({ service: PDS_URL })
  const update = db.prepare(
    'UPDATE posts SET replyRootCid = ?, replyParentCid = ? WHERE uri = ?',
  )

  const cidCache = new Map<string, string | null>()
  const fetchCid = async (uri: string): Promise<string | null> => {
    if (cidCache.has(uri)) return cidCache.get(uri)!
    const parts = parseAtUri(uri)
    if (!parts) {
      cidCache.set(uri, null)
      return null
    }
    try {
      const res = await agent.com.atproto.repo.getRecord(parts)
      const cid = res.data.cid ?? null
      cidCache.set(uri, cid)
      return cid
    } catch (err) {
      console.warn(`${uri}: ${err instanceof Error ? err.message : err}`)
      cidCache.set(uri, null)
      return null
    }
  }

  let filled = 0
  let unresolved = 0
  for (const r of rows) {
    const rootUri = r.replyRootUri ?? r.replyParentUri
    const parentUri = r.replyParentUri
    if (!parentUri) continue

    const rootCid = r.replyRootCid ?? (rootUri ? await fetchCid(rootUri) : null)
    const parentCid = r.replyParentCid ?? (await fetchCid(parentUri))

    if (rootCid && parentCid) {
      update.run(rootCid, parentCid, r.uri)
      filled++
    } else {
      unresolved++
    }
  }

  console.log(`done. filled: ${filled}, unresolved: ${unresolved}`)
  db.close()
}

main().catch((err) => {
  console.error('backfill failed:', err)
  process.exit(1)
})
