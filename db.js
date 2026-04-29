const Database = require('better-sqlite3');
const path = require('path');

// On Railway/Render, set DB_PATH env var to a persistent volume path (e.g. /data/flashcards.db)
// Locally it just uses the project directory as before.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'flashcards.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chinese TEXT NOT NULL,
    pinyin TEXT,
    english TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#4f8ef7',
    is_smart INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS card_groups (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, group_id)
  );

  CREATE TABLE IF NOT EXISTS study_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    correct INTEGER NOT NULL,
    studied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'topic',
    color TEXT DEFAULT '#6366f1',
    emoji TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 100
  );

  CREATE TABLE IF NOT EXISTS card_tags (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, tag_id)
  );
`);

// Seed default smart groups
const seedGroups = db.prepare(`
  INSERT OR IGNORE INTO groups (name, color, is_smart) VALUES (?, ?, ?)
`);
seedGroups.run('All Cards', '#6366f1', 1);
seedGroups.run('New Cards', '#22c55e', 1);
seedGroups.run('Recent Mistakes', '#ef4444', 1);
seedGroups.run('Struggling', '#f97316', 1);
seedGroups.run('Mastered', '#8b5cf6', 1);

module.exports = db;
