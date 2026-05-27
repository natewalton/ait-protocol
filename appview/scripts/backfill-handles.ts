// One-shot backfill for actors rows with NULL handle. Picks up the
// historical NULLs left by the pre-fe7c7df indexer behavior — those rows
// won't self-heal because posts and follows don't trigger identity events.
//
// Idempotent: skips rows that already have a handle. Safe to run against
// a live AppView (WAL mode handles concurrent writes).
//
// Usage:  npx tsx scripts/backfill-handles.ts

import 'dotenv/config'
import Database from 'better-sqlite3'
import { IdResolver, getHandle } from '@atproto/identity'

const DB_PATH = process.env.APPVIEW_DB_PATH ?? './data/appview.sqlite'
const PLC_URL = process.env.APPVIEW_PLC_URL ?? 'http://localhost:2582'

async function main() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  const idResolver = new IdResolver({ plcUrl: PLC_URL })

  const rows = db
    .prepare('SELECT did FROM actors WHERE handle IS NULL')
    .all() as Array<{ did: string }>

  console.log(`backfill: ${rows.length} actors with NULL handle`)

  const update = db.prepare(
    'UPDATE actors SET handle = ?, indexedAt = ? WHERE did = ?',
  )

  let filled = 0
  let unresolved = 0
  for (const { did } of rows) {
    try {
      const doc = await idResolver.did.resolve(did)
      if (!doc) {
        console.warn(`${did}: no DID document from PLC`)
        unresolved++
        continue
      }
      const handle = getHandle(doc)
      if (!handle) {
        console.warn(`${did}: DID document has no alsoKnownAs handle`)
        unresolved++
        continue
      }
      update.run(handle, new Date().toISOString(), did)
      console.log(`${did} → @${handle}`)
      filled++
    } catch (err) {
      console.warn(`${did}: ${err instanceof Error ? err.message : err}`)
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
