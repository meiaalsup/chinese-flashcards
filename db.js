const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required (Postgres connection string).');
}

function poolSsl() {
  if (process.env.PGSSL === 'false') return false;
  const u = DATABASE_URL;
  if (/\/\/(localhost|127\.0\.0\.1)/i.test(u)) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: poolSsl() });
const txStore = new AsyncLocalStorage();

function normalizeParams(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : [...args];
}

/** SQLite-style ? placeholders and a few dialect tweaks → Postgres */
function sqlToPg(sql) {
  let s = sql.replace(/datetime\('now',\s*'-7 days'\)/gi, "(NOW() - INTERVAL '7 days')");

  const ign = /INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)/i.exec(s);
  if (ign) {
    const t = ign[1].toLowerCase();
    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)/i, 'INSERT INTO $1');
    const conflict = {
      groups: '(name)',
      card_groups: '(card_id, group_id)',
      card_tags: '(card_id, tag_id)',
    }[t];
    if (conflict && !/ON\s+CONFLICT/i.test(s)) {
      s = s.trim().replace(/;\s*$/, '') + ` ON CONFLICT ${conflict} DO NOTHING`;
    }
  }

  let i = 0;
  s = s.replace(/\?/g, () => `$${++i}`);
  return s;
}

async function rawQuery(text, params = []) {
  const client = txStore.getStore();
  if (client) return client.query(text, params);
  return pool.query(text, params);
}

function appendReturningId(text) {
  const t = text.trim().replace(/;?\s*$/, '');
  if (/RETURNING/i.test(t)) return t;
  return `${t} RETURNING id`;
}

function shouldReturnIdForInsert(text) {
  const m = /^\s*INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(text);
  if (!m) return false;
  const table = m[1].toLowerCase();
  const noIdTables = new Set(['card_groups', 'card_tags']);
  return !noIdTables.has(table);
}

function shouldReturnIdForUpdate(text) {
  const m = /^\s*UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(text);
  if (!m) return false;
  const table = m[1].toLowerCase();
  const noIdTables = new Set(['card_groups', 'card_tags']);
  return !noIdTables.has(table);
}

async function initSchema() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      chinese TEXT NOT NULL,
      pinyin TEXT,
      english TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      learned INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#4f8ef7',
      is_smart INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS card_groups (
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, group_id)
    )`,
    `CREATE TABLE IF NOT EXISTS study_log (
      id SERIAL PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      correct INTEGER NOT NULL,
      studied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tags (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'topic',
      color TEXT DEFAULT '#6366f1',
      emoji TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 100
    )`,
    `CREATE TABLE IF NOT EXISTS card_tags (
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, tag_id)
    )`,
  ];

  for (const sql of stmts) {
    await rawQuery(sql);
  }

  await rawQuery(`
    INSERT INTO groups (name, color, is_smart) VALUES
      ('All Cards', '#6366f1', 1),
      ('New Cards', '#22c55e', 1),
      ('Recent Mistakes', '#ef4444', 1),
      ('Struggling', '#f97316', 1),
      ('Mastered', '#8b5cf6', 1),
      ('Learned', '#10b981', 1)
    ON CONFLICT (name) DO NOTHING
  `);

  const indexStmts = [
    'CREATE INDEX IF NOT EXISTS idx_cards_learned_created_at ON cards (learned, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_study_log_card_id ON study_log (card_id)',
    'CREATE INDEX IF NOT EXISTS idx_study_log_card_id_studied_at ON study_log (card_id, studied_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_study_log_correct_studied_at ON study_log (correct, studied_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_card_groups_group_id ON card_groups (group_id)',
    'CREATE INDEX IF NOT EXISTS idx_card_tags_card_id ON card_tags (card_id)',
    'CREATE INDEX IF NOT EXISTS idx_card_tags_tag_id ON card_tags (tag_id)',
    'CREATE INDEX IF NOT EXISTS idx_tags_type ON tags (type)',
  ];
  for (const sql of indexStmts) {
    await rawQuery(sql);
  }
}

function createDb() {
  return {
    async pragma() {},
    async exec(sql) {
      await rawQuery(sqlToPg(sql));
    },
    prepare(sql) {
      return {
        async run(...args) {
          const params = normalizeParams(args);
          let text = sqlToPg(sql);
          if (shouldReturnIdForInsert(text) && !/RETURNING/i.test(text)) {
            text = appendReturningId(text);
          } else if (shouldReturnIdForUpdate(text) && !/RETURNING/i.test(text)) {
            text = appendReturningId(text);
          }
          const result = await rawQuery(text, params);
          return {
            changes: result.rowCount || 0,
            lastInsertRowid: result.rows[0]?.id ?? null,
          };
        },
        async get(...args) {
          const result = await rawQuery(sqlToPg(sql), normalizeParams(args));
          return result.rows[0];
        },
        async all(...args) {
          const result = await rawQuery(sqlToPg(sql), normalizeParams(args));
          return result.rows;
        },
      };
    },
    transaction(fn) {
      return async (...args) => {
        const existingClient = txStore.getStore();
        if (existingClient) {
          // Reuse the current transaction context so nested calls can see uncommitted rows.
          return fn(...args);
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await txStore.run(client, () => fn(...args));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      };
    },
  };
}

const db = createDb();

module.exports = initSchema().then(() => db);
