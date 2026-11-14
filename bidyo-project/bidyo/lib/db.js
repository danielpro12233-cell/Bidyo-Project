'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

// SQLite in WAL mode: many concurrent readers + a writer. Plenty for thousands of concurrent viewers.
const db = new DatabaseSync(path.join(cfg.DATA_DIR, 'bidyo.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  send_count   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'public',   -- public | unlisted | private
  status      TEXT NOT NULL DEFAULT 'published',-- published | draft
  file        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  duration    REAL NOT NULL DEFAULT 0,
  has_thumb   INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_feed ON videos(status, visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_cat  ON videos(category, status, visibility);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
`);

module.exports = db;
