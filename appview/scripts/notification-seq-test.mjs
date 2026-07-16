// Offline tests for notification seq ordering, the migration, and cursors.
// Every check guards a decision that is easy to undo by accident — the
// assertion names say which.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'notification-seq-test-'))

const { default: Database } = await import('better-sqlite3')
const { openDb } = await import('../dist/db.js')
const { encodeSeqCursor, decodeSeqCursor, encodeCursor } = await import(
  '../dist/queries/cursor.js'
)
const { seqBeforeTimestamp } = await import('../dist/queries/listNotifications.js')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const T = '2026-05-27T21:23:30.810Z' // the millisecond two live notifications shared
const RECIP = 'did:plc:recipient'
const AUTHOR = 'did:plc:author'

// Build a pre-seq database in the shape the migration has to upgrade: the old
// composite PK, the old createdAt index, no seq column.
function makePreSeqDb(path) {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE notifications (
      uri TEXT NOT NULL, cid TEXT NOT NULL, recipientDid TEXT NOT NULL,
      authorDid TEXT NOT NULL, reason TEXT NOT NULL, reasonSubject TEXT,
      createdAt TEXT NOT NULL, indexedAt TEXT NOT NULL,
      PRIMARY KEY (uri, recipientDid)
    );
    CREATE INDEX notifications_by_recipient ON notifications(recipientDid, createdAt DESC);
  `)
  return db
}

const insertPreSeq = (db, uri, reason, indexedAt) =>
  db
    .prepare(
      `INSERT INTO notifications (uri,cid,recipientDid,authorDid,reason,reasonSubject,createdAt,indexedAt)
       VALUES (?,?,?,?,?,NULL,?,?)`,
    )
    .run(uri, `cid-${uri}`, RECIP, AUTHOR, reason, indexedAt, indexedAt)

// --- migration ---
console.log('\nmigration')
const legacyPath = join(tmp, 'legacy.sqlite')
{
  const raw = makePreSeqDb(legacyPath)
  // Insert the twins in a known rowid order: follow first, then reply, sharing
  // one millisecond. A timestamp bound cannot tell these apart; seq must.
  insertPreSeq(raw, 'at://x/follow/1', 'follow', T)
  insertPreSeq(raw, 'at://x/post/1', 'reply', T)
  insertPreSeq(raw, 'at://x/post/2', 'mention', '2026-05-27T21:23:31.000Z')
  raw.close()
}

const migrated = openDb(legacyPath)
const migCols = migrated.pragma('table_info(notifications)').map((c) => c.name)
check('migrated schema has seq', migCols.includes('seq'))
check(
  'row count preserved',
  migrated.prepare('SELECT COUNT(*) c FROM notifications').get().c === 3,
)

const seqRows = migrated
  .prepare('SELECT seq, reason FROM notifications ORDER BY seq')
  .all()
check(
  'seq assigned in rowid (insertion) order',
  JSON.stringify(seqRows.map((r) => r.reason)) ===
    JSON.stringify(['follow', 'reply', 'mention']),
  JSON.stringify(seqRows),
)

const twins = migrated
  .prepare('SELECT seq FROM notifications WHERE indexedAt = ? ORDER BY seq')
  .all(T)
check(
  'same-millisecond twins get distinct seqs',
  twins.length === 2 && twins[0].seq !== twins[1].seq,
  JSON.stringify(twins),
)

// Guards the shared DDL const: a fresh DB and a migrated one must not drift.
const fresh = openDb(join(tmp, 'fresh.sqlite'))
const freshCols = fresh.pragma('table_info(notifications)').map((c) => c.name)
check(
  'fresh and migrated schemas are identical',
  JSON.stringify(freshCols) === JSON.stringify(migCols),
  `${JSON.stringify(freshCols)} vs ${JSON.stringify(migCols)}`,
)
fresh.close()

// --- idempotency: this runs against the real DB on every server start ---
const seqsBefore = JSON.stringify(
  migrated.prepare('SELECT seq FROM notifications ORDER BY seq').all(),
)
migrated.close()
const reopened = openDb(legacyPath)
const seqsAfter = JSON.stringify(
  reopened.prepare('SELECT seq FROM notifications ORDER BY seq').all(),
)
check('second boot does not rebuild or renumber', seqsBefore === seqsAfter)

// --- the UNIQUE that replaced the composite PK ---
console.log('\nconstraints')
const before = reopened.prepare('SELECT COUNT(*) c FROM notifications').get().c
reopened
  .prepare(
    `INSERT INTO notifications (uri,cid,recipientDid,authorDid,reason,reasonSubject,createdAt,indexedAt)
     VALUES ('at://x/post/1','cid-x',?,?,'mention',NULL,?,?)
     ON CONFLICT(uri, recipientDid) DO NOTHING`,
  )
  .run(RECIP, AUTHOR, T, T)
check(
  'ON CONFLICT(uri,recipientDid) still collapses against the UNIQUE',
  reopened.prepare('SELECT COUNT(*) c FROM notifications').get().c === before,
)

// --- AUTOINCREMENT non-reuse ---
// Load-bearing: indexer.ts DELETEs notification rows. A recycled seq would land
// behind a consumer's cursor and never replay.
const maxBefore = reopened.prepare('SELECT MAX(seq) m FROM notifications').get().m
reopened.prepare('DELETE FROM notifications WHERE seq = ?').run(maxBefore)
reopened
  .prepare(
    `INSERT INTO notifications (uri,cid,recipientDid,authorDid,reason,reasonSubject,createdAt,indexedAt)
     VALUES ('at://x/post/9','cid-9',?,?,'reply',NULL,?,?)`,
  )
  .run(RECIP, AUTHOR, T, T)
const maxAfter = reopened.prepare('SELECT MAX(seq) m FROM notifications').get().m
check(
  'AUTOINCREMENT does not recycle a deleted seq',
  maxAfter > maxBefore,
  `deleted ${maxBefore}, next insert got ${maxAfter}`,
)

// --- cursor codec ---
console.log('\ncursor codec')
check('seq cursor round-trips', decodeSeqCursor(encodeSeqCursor(42)) === 42)
// A tuple cursor decaying to NaN would compare true against every row, so
// rejection has to be explicit rather than incidental.
check(
  'a post-feed tuple cursor decodes to null, not NaN',
  decodeSeqCursor(encodeCursor('2026-01-01T00:00:00Z', 'at://x')) === null,
)
check('garbage decodes to null', decodeSeqCursor('!!!not-base64!!!') === null)
check('negative/spoofed cursor rejected', decodeSeqCursor(Buffer.from('-5').toString('base64url')) === null)

// --- legacy ISO cursor translation ---
console.log('\nlegacy ISO cursor healing')
// A session that delivered the follow committed its indexedAt = T. Its twin,
// the reply, shares T and was never delivered.
const twinSeqs = reopened
  .prepare('SELECT seq, reason FROM notifications WHERE indexedAt = ? ORDER BY seq')
  .all(T)
const pred = seqBeforeTimestamp(reopened, RECIP, T)
const healed = reopened
  .prepare('SELECT seq FROM notifications WHERE recipientDid = ? AND seq > ? ORDER BY seq')
  .all(RECIP, pred)
  .map((r) => r.seq)
const oldBound = reopened
  .prepare('SELECT seq FROM notifications WHERE recipientDid = ? AND indexedAt > ? ORDER BY seq')
  .all(RECIP, T)
  .map((r) => r.seq)
check(
  'legacy cursor at a twin boundary replays BOTH twins',
  twinSeqs.every((t) => healed.includes(t.seq)),
  `pred=${pred} healed=${JSON.stringify(healed)}`,
)
check(
  'the old indexedAt > since bound dropped a twin (regression guard)',
  !twinSeqs.every((t) => oldBound.includes(t.seq)),
  `old bound gave ${JSON.stringify(oldBound)}`,
)

const future = seqBeforeTimestamp(reopened, RECIP, '2099-01-01T00:00:00.000Z')
const futureReplay = reopened
  .prepare('SELECT COUNT(*) c FROM notifications WHERE recipientDid = ? AND seq > ?')
  .get(RECIP, future).c
check(
  'a `since` in the future replays nothing, not everything',
  futureReplay === 0,
  `pred=${future} would replay ${futureReplay}`,
)
check(
  'a `since` before the stream replays everything',
  seqBeforeTimestamp(reopened, RECIP, '1970-01-01T00:00:00.000Z') === 0,
)
check('unknown recipient yields 0', seqBeforeTimestamp(reopened, 'did:plc:nobody', T) === 0)

reopened.close()
rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? '\nnotification-seq: all green' : `\nnotification-seq: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
