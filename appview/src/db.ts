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
      uri        TEXT PRIMARY KEY,
      cid        TEXT NOT NULL,
      did        TEXT NOT NULL,
      text       TEXT NOT NULL,
      facets     TEXT,
      createdAt  TEXT NOT NULL,
      indexedAt  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_by_did ON posts(did, createdAt DESC);

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
  `)
  return db
}

export type Db = ReturnType<typeof openDb>
