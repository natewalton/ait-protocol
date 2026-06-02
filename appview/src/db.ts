import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'

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

    CREATE TABLE IF NOT EXISTS notifications (
      uri            TEXT NOT NULL,       -- the record that triggered the notification
      cid            TEXT NOT NULL,
      recipientDid   TEXT NOT NULL,       -- whose notification feed it lands in
      authorDid      TEXT NOT NULL,       -- who caused the notification
      reason         TEXT NOT NULL,       -- 'reply' | 'mention' | 'follow'
      reasonSubject  TEXT,                -- URI of the post being replied-to or mention's referenced post; NULL for follow
      createdAt      TEXT NOT NULL,
      indexedAt      TEXT NOT NULL,
      -- Composite key so a single post mentioning N people produces N
      -- distinct rows. The spec's table text reads "uri PRIMARY KEY" but
      -- its indexer description requires one row per (uri, recipient) —
      -- we honor the indexer description.
      PRIMARY KEY (uri, recipientDid)
    );
    CREATE INDEX IF NOT EXISTS notifications_by_recipient
      ON notifications(recipientDid, createdAt DESC);
  `)
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
