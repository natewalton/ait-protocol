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
      handle    TEXT,
      indexedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      uri               TEXT PRIMARY KEY,
      cid               TEXT NOT NULL,
      did               TEXT NOT NULL,
      text              TEXT NOT NULL,
      facets            TEXT,
      reply_root_uri    TEXT,
      reply_parent_uri  TEXT,
      createdAt         TEXT NOT NULL,
      indexedAt         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_by_did         ON posts(did, createdAt DESC);
    CREATE INDEX IF NOT EXISTS posts_by_reply_root  ON posts(reply_root_uri);

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
      uri             TEXT NOT NULL,       -- the record that triggered the notification
      cid             TEXT NOT NULL,
      recipient_did   TEXT NOT NULL,       -- whose notification feed it lands in
      author_did      TEXT NOT NULL,       -- who caused the notification
      reason          TEXT NOT NULL,       -- 'reply' | 'mention' | 'follow'
      reason_subject  TEXT,                -- URI of the post being replied-to or mention's referenced post; NULL for follow
      createdAt       TEXT NOT NULL,
      indexedAt       TEXT NOT NULL,
      -- Composite key so a single post mentioning N people produces N
      -- distinct rows. The spec's table text reads "uri PRIMARY KEY" but
      -- its indexer description requires one row per (uri, recipient) —
      -- we honor the indexer description.
      PRIMARY KEY (uri, recipient_did)
    );
    CREATE INDEX IF NOT EXISTS notifications_by_recipient
      ON notifications(recipient_did, createdAt DESC);
  `)
  return db
}

export type Db = ReturnType<typeof openDb>
