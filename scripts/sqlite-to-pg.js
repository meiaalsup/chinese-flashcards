#!/usr/bin/env node
/**
 * One-time copy from local flashcards.db (SQLite) into Postgres (DATABASE_URL).
 * Run after the app (or db.js) has created empty tables, or this script truncates
 * user tables first when SQLITE_TO_PG_TRUNCATE=1.
 *
 *   DATABASE_URL=postgresql://... SQLITE_TO_PG_TRUNCATE=1 node scripts/sqlite-to-pg.js
 *
 * Requires devDependency: better-sqlite3
 */
require('dotenv').config();

const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL to your Postgres connection string.');
  process.exit(1);
}

function poolSsl() {
  if (process.env.PGSSL === 'false') return false;
  if (/\/\/(localhost|127\.0\.0\.1)/i.test(DATABASE_URL)) return false;
  return { rejectUnauthorized: false };
}

const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'flashcards.db');

async function main() {
  const Database = require('better-sqlite3');
  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: poolSsl() });

  if (process.env.SQLITE_TO_PG_TRUNCATE === '1') {
    await pool.query(`
      TRUNCATE card_tags, card_groups, study_log, cards, tags, groups RESTART IDENTITY CASCADE
    `);
  }

  const groups = sqlite.prepare('SELECT * FROM groups').all();
  for (const row of groups) {
    await pool.query(
      `INSERT INTO groups (id, name, color, is_smart, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, color = EXCLUDED.color, is_smart = EXCLUDED.is_smart, created_at = EXCLUDED.created_at`,
      [row.id, row.name, row.color, row.is_smart, row.created_at]
    );
  }

  const tags = sqlite.prepare('SELECT * FROM tags').all();
  for (const row of tags) {
    await pool.query(
      `INSERT INTO tags (id, name, type, color, emoji, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, type = EXCLUDED.type, color = EXCLUDED.color,
         emoji = EXCLUDED.emoji, sort_order = EXCLUDED.sort_order`,
      [row.id, row.name, row.type, row.color, row.emoji, row.sort_order]
    );
  }

  const cards = sqlite.prepare('SELECT * FROM cards').all();
  for (const row of cards) {
    await pool.query(
      `INSERT INTO cards (id, chinese, pinyin, english, created_at, learned)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         chinese = EXCLUDED.chinese, pinyin = EXCLUDED.pinyin, english = EXCLUDED.english,
         created_at = EXCLUDED.created_at, learned = EXCLUDED.learned`,
      [row.id, row.chinese, row.pinyin, row.english, row.created_at, row.learned]
    );
  }

  const studyLog = sqlite.prepare('SELECT * FROM study_log').all();
  for (const row of studyLog) {
    await pool.query(
      `INSERT INTO study_log (id, card_id, correct, studied_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         card_id = EXCLUDED.card_id, correct = EXCLUDED.correct, studied_at = EXCLUDED.studied_at`,
      [row.id, row.card_id, row.correct, row.studied_at]
    );
  }

  const cardGroups = sqlite.prepare('SELECT * FROM card_groups').all();
  for (const row of cardGroups) {
    await pool.query(
      `INSERT INTO card_groups (card_id, group_id) VALUES ($1, $2)
       ON CONFLICT (card_id, group_id) DO NOTHING`,
      [row.card_id, row.group_id]
    );
  }

  const cardTags = sqlite.prepare('SELECT * FROM card_tags').all();
  for (const row of cardTags) {
    await pool.query(
      `INSERT INTO card_tags (card_id, tag_id) VALUES ($1, $2)
       ON CONFLICT (card_id, tag_id) DO NOTHING`,
      [row.card_id, row.tag_id]
    );
  }

  await pool.query("SELECT setval(pg_get_serial_sequence('groups','id'), COALESCE((SELECT MAX(id) FROM groups), 1))");
  await pool.query("SELECT setval(pg_get_serial_sequence('tags','id'), COALESCE((SELECT MAX(id) FROM tags), 1))");
  await pool.query("SELECT setval(pg_get_serial_sequence('cards','id'), COALESCE((SELECT MAX(id) FROM cards), 1))");
  await pool.query("SELECT setval(pg_get_serial_sequence('study_log','id'), COALESCE((SELECT MAX(id) FROM study_log), 1))");

  sqlite.close();
  await pool.end();
  console.log('SQLite → Postgres copy finished.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
