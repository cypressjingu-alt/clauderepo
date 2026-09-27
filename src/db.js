import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Local only: a live SQLite file corrupts under Syncthing.
export function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,              -- music | bed | event | visual
      tag TEXT NOT NULL,               -- folder name: genre, bed/event type, or aesthetic
      source_id TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,       -- relative to the pool root, forward slashes
      size INTEGER, mtime REAL,
      sha256 TEXT NOT NULL,
      fingerprint TEXT,
      duration REAL,                   -- null for still images
      lufs REAL, true_peak REAL,
      peak_p99 REAL,                   -- sample peak exceeded in only 1% of 1-second windows
      lead_silence REAL DEFAULT 0, trail_silence REAL DEFAULT 0,
      bpm REAL, key TEXT, energy REAL, analyzed INTEGER DEFAULT 0,
      width INTEGER, height INTEGER,
      artist TEXT, title TEXT, credit_guessed INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 0, blocked_reason TEXT,
      missing INTEGER DEFAULT 0,
      added_at TEXT
    );
    CREATE INDEX IF NOT EXISTS assets_sha ON assets (sha256);
    CREATE TABLE IF NOT EXISTS usage (
      asset_id INTEGER NOT NULL, channel_id TEXT NOT NULL, render_id TEXT NOT NULL, used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_channel ON usage (channel_id, asset_id);
    CREATE TABLE IF NOT EXISTS renders (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, niche_id TEXT NOT NULL, status TEXT NOT NULL,
      seed INTEGER, target_length REAL, dir TEXT, qa TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT,
      created_at TEXT, delivered_at TEXT
    );
  `);
  // Added after the first dev DBs existed: add the column, and clear mtimes so the next ingest re-measures every file.
  if (!db.prepare('PRAGMA table_info(assets)').all().some(c => c.name === 'peak_p99')) {
    db.exec('ALTER TABLE assets ADD COLUMN peak_p99 REAL; UPDATE assets SET mtime = NULL;');
  }
  return db;
}

export const addAlert = (db, channel, type, payload) =>
  db.prepare('INSERT INTO alerts (channel_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(channel, type, JSON.stringify(payload), new Date().toISOString());
