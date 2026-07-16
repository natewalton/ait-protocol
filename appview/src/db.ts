import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Single source of truth: openDb creates from this, and addNotificationSeq
// rebuilds from the same string, so a fresh DB and a migrated one can't drift.
const NOTIFICATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS notifications (
    -- The AppView's own monotonic sequence for its outbound notification
    -- stream, mirroring the PDS sequencer's repo_seq ("seq integer primary key
    -- autoincrement"). It is the ONLY ordering anything cursors on: indexedAt
    -- is millisecond-resolution and collides (a reply and a follow landing in
    -- the same millisecond are indistinguishable to a timestamp bound), and
    -- createdAt is sender-supplied and backdatable. AUTOINCREMENT is
    -- load-bearing rather than decoration: plain rowids get recycled after the
    -- DELETEs in indexer.ts, and a recycled seq would land behind a consumer's
    -- cursor and never be replayed.
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    uri            TEXT NOT NULL,       -- the record that triggered the notification
    cid            TEXT NOT NULL,
    recipientDid   TEXT NOT NULL,       -- whose notification feed it lands in
    authorDid      TEXT NOT NULL,       -- who caused the notification
    reason         TEXT NOT NULL,       -- 'reply' | 'mention' | 'follow'
    reasonSubject  TEXT,                -- URI of the post being replied-to or the mention's post; NULL for follow
    createdAt      TEXT NOT NULL,
    indexedAt      TEXT NOT NULL,
    -- Was the PRIMARY KEY before seq existed; kept as UNIQUE so one post
    -- mentioning N people still produces N rows, and so the indexer's
    -- ON CONFLICT(uri, recipientDid) DO NOTHING still resolves against it.
    UNIQUE (uri, recipientDid)
  );
`

// Serves listNotifications (seq DESC) and the push replay (seq ASC, scanned
// backwards) from one index.
const NOTIFICATIONS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS notifications_by_recipient
    ON notifications(recipientDid, seq DESC);
`

export function openDb(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS actors (
      did       TEXT PRIMARY KEY,
      active    INTEGER NOT NULL DEFAULT 1,
      status    TEXT,
      indexedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      uri             TEXT PRIMARY KEY,
      cid             TEXT NOT NULL,
      did             TEXT NOT NULL,
      text            TEXT NOT NULL,
      facets          TEXT,
      replyRootUri    TEXT,
      replyParentUri  TEXT,
      replyRootCid    TEXT,
      replyParentCid  TEXT,
      createdAt       TEXT NOT NULL,
      indexedAt       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_by_did         ON posts(did, createdAt DESC);
    CREATE INDEX IF NOT EXISTS posts_by_reply_root  ON posts(replyRootUri);

    CREATE TABLE IF NOT EXISTS follows (
      uri        TEXT PRIMARY KEY,
      did        TEXT NOT NULL,            -- the follower
      subject    TEXT NOT NULL,            -- the followee DID
      createdAt  TEXT NOT NULL,
      indexedAt  TEXT NOT NULL,
      UNIQUE(did, subject)
    );
    CREATE INDEX IF NOT EXISTS follows_by_did     ON follows(did);
    CREATE INDEX IF NOT EXISTS follows_by_subject ON follows(subject);

    CREATE TABLE IF NOT EXISTS profiles (
      did          TEXT PRIMARY KEY,
      displayName  TEXT,
      description  TEXT,
      avatarCid    TEXT,
      indexedAt    TEXT NOT NULL
    );

  `)
  db.exec(NOTIFICATIONS_TABLE_DDL)
  addNotificationSeq(db)
  // After the migration, so `seq` is guaranteed to exist on the table this
  // indexes. Creating it in the block above would reference seq on a pre-seq
  // table and only survive by IF NOT EXISTS happening to match the old index
  // of the same name.
  db.exec(NOTIFICATIONS_INDEX_DDL)
  addMissingColumns(db, 'posts', {
    replyRootCid: 'TEXT',
    replyParentCid: 'TEXT',
  })
  addMissingColumns(db, 'actors', {
    active: 'INTEGER NOT NULL DEFAULT 1',
    status: 'TEXT',
  })
  dropHandleColumn(db)
  return db
}

// One-shot migration. Pre-spec `actors` carried a `handle` column maintained
// from #identity events; ADR-0038 removes it because the AppView can't
// always honor that claim after a cold restart. Idempotent — checks
// table_info first, no-ops if already dropped. SQLite 3.35+ (shipped by
// better-sqlite3 ≥11) supports ALTER TABLE … DROP COLUMN directly.
function dropHandleColumn(db: Database.Database) {
  const cols = db.pragma('table_info(actors)') as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'handle')) return
  db.exec(`
    DROP INDEX IF EXISTS actors_by_handle;
    ALTER TABLE actors DROP COLUMN handle;
  `)
}

// One-shot migration to the seq-ordered notifications table. Pre-seq rows keyed
// on PRIMARY KEY (uri, recipientDid) and were cursored by indexedAt; SQLite
// can't add a primary key in place, so the table is rebuilt. Idempotent —
// checks table_info first, no-ops once `seq` exists.
//
// The copy is ordered by rowid — the original insertion order, so existing rows
// get the seqs they would have been assigned at insert, and same-millisecond
// twins (the collisions that motivated seq) keep their true relative order
// rather than an arbitrary one. Ordering by indexedAt first would rank rows by
// a clock that can move backwards; measured across the 500 live rows the two
// orderings agree exactly, so rowid costs nothing and is the ground truth.
function addNotificationSeq(db: Database.Database) {
  const cols = db.pragma('table_info(notifications)') as Array<{ name: string }>
  if (cols.length === 0 || cols.some((c) => c.name === 'seq')) return
  // db.transaction rather than BEGIN/COMMIT inside exec: exec stops at the
  // first failing statement and would leave the transaction open on this
  // connection, mid-rebuild. The wrapper rolls back instead.
  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS notifications_by_recipient')
    db.exec('ALTER TABLE notifications RENAME TO notifications_preseq')
    db.exec(NOTIFICATIONS_TABLE_DDL)
    db.exec(`
      INSERT INTO notifications
        (uri, cid, recipientDid, authorDid, reason, reasonSubject, createdAt, indexedAt)
        SELECT uri, cid, recipientDid, authorDid, reason, reasonSubject, createdAt, indexedAt
        FROM notifications_preseq
        ORDER BY rowid
    `)
    db.exec('DROP TABLE notifications_preseq')
  })()
}

function addMissingColumns(
  db: Database.Database,
  table: string,
  columns: Record<string, string>,
) {
  const existing = new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  )
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
    }
  }
}

export type Db = ReturnType<typeof openDb>
