import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Shared by openDb and addNotificationSeq so a fresh DB and a migrated one
// can't drift apart.
const NOTIFICATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS notifications (
    -- The only ordering anything cursors on. AUTOINCREMENT is required, not
    -- decoration: indexer.ts deletes rows, plain rowids get recycled, and a
    -- recycled seq would land behind a consumer's cursor and never replay.
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    uri            TEXT NOT NULL,
    cid            TEXT NOT NULL,
    recipientDid   TEXT NOT NULL,       -- whose notification feed it lands in
    authorDid      TEXT NOT NULL,       -- who caused the notification
    reason         TEXT NOT NULL,       -- 'reply' | 'mention' | 'follow'
    reasonSubject  TEXT,                -- replied-to or mentioning post; NULL for follow
    createdAt      TEXT NOT NULL,
    indexedAt      TEXT NOT NULL,       -- display only; collides, never a cursor
    -- Keeps one row per (post, recipient) and backs the indexer's
    -- ON CONFLICT(uri, recipientDid) DO NOTHING.
    UNIQUE (uri, recipientDid)
  );
`

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
  // Must follow the migration: the index references seq, which a pre-seq table
  // doesn't have yet.
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

// One-shot rebuild: SQLite can't add a primary key in place. No-ops once `seq`
// exists, so it runs exactly once per database.
//
// ORDER BY rowid — insertion order — hands existing rows the seqs they'd have
// been assigned at insert. indexedAt would rank them by a clock that can move
// backwards.
function addNotificationSeq(db: Database.Database) {
  const cols = db.pragma('table_info(notifications)') as Array<{ name: string }>
  if (cols.length === 0 || cols.some((c) => c.name === 'seq')) return
  // Not BEGIN/COMMIT inside exec: exec stops at the first failing statement and
  // leaves the transaction open mid-rebuild. This rolls back.
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
