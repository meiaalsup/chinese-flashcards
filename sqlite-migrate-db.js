/**
 * Opens the local SQLite flashcards.db for one-off legacy migration scripts only.
 * The running app uses Postgres via ./db.js (DATABASE_URL).
 */
require('dotenv').config();

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'flashcards.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
