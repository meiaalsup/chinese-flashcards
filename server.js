require('dotenv').config();

const express = require('express');
const path = require('path');
const dbPromise = require('./db');
const { autoTagCard } = require('./autotag');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;
const dbReady = dbPromise.then((d) => { db = d; return d; });

app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (err) {
    next(err);
  }
});

// ─── Dict module (ESM, loaded async at startup) ──────────────────────────────

let dictLookupChinese = null;
let dictLookupEnglish = null;
let dictReady = false;
let dictInitPromise = null;

async function initDictionary(log = false) {
  if (dictInitPromise) return dictInitPromise;
  dictInitPromise = (async () => {
    try {
      const dict = await import('./dict.mjs');
      dictLookupChinese = dict.lookupChinese;
      dictLookupEnglish = dict.lookupEnglish;
      dictReady = true;
      if (log) console.log('Dictionary loaded. Auto-lookup is ready.\n');
    } catch (err) {
      if (log) {
        console.error('Dictionary failed to load:', err.message);
        console.log('Pinyin and translations will need to be entered manually.\n');
      }
    }
  })();
  return dictInitPromise;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isChinese(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text);
}

function parseInput(raw) {
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

async function getCardStats(cardId) {
  const total = await db.prepare('SELECT COUNT(*) as n FROM study_log WHERE card_id = ?').get(cardId);
  const correct = await db.prepare('SELECT COUNT(*) as n FROM study_log WHERE card_id = ? AND correct = 1').get(cardId);
  return { total: Number(total.n), correct: Number(correct.n) };
}

async function attachStats(cards) {
  if (!cards.length) return [];

  const ids = cards.map(c => c.id);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT
      card_id,
      COUNT(*)::int AS total,
      SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END)::int AS correct
    FROM study_log
    WHERE card_id IN (${placeholders})
    GROUP BY card_id
  `).all(...ids);

  const statsById = new Map(rows.map(r => [Number(r.card_id), { total: Number(r.total), correct: Number(r.correct) }]));
  return cards.map(c => ({ ...c, stats: statsById.get(Number(c.id)) || { total: 0, correct: 0 } }));
}

async function resolveSmartGroup(name) {
  switch (name) {
    case 'All Cards':
      return await db.prepare('SELECT * FROM cards WHERE learned = 0 ORDER BY created_at DESC').all();

    case 'New Cards':
      return await db.prepare(`
        SELECT c.* FROM cards c
        LEFT JOIN study_log sl ON sl.card_id = c.id
        WHERE sl.id IS NULL AND c.learned = 0
        ORDER BY c.created_at DESC
      `).all();

    case 'Recent Mistakes':
      return await db.prepare(`
        SELECT
          c.*,
          MAX(sl.studied_at) AS last_mistake_at
        FROM cards c
        JOIN study_log sl ON sl.card_id = c.id
        WHERE sl.correct = 0 AND sl.studied_at >= datetime('now', '-7 days') AND c.learned = 0
        GROUP BY c.id
        ORDER BY last_mistake_at DESC
      `).all();

    case 'Struggling': {
      return await db.prepare(`
        SELECT c.* FROM cards c
        LEFT JOIN study_log sl ON sl.card_id = c.id
        WHERE c.learned = 0
        GROUP BY c.id
        HAVING COUNT(sl.id) >= 3
          AND (SUM(CASE WHEN sl.correct = 1 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(sl.id), 0)) < 0.5
        ORDER BY c.created_at DESC
      `).all();
    }

    case 'Mastered': {
      return await db.prepare(`
        SELECT c.* FROM cards c
        LEFT JOIN study_log sl ON sl.card_id = c.id
        WHERE c.learned = 0
        GROUP BY c.id
        HAVING COUNT(sl.id) >= 5
          AND (SUM(CASE WHEN sl.correct = 1 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(sl.id), 0)) >= 0.8
        ORDER BY c.created_at DESC
      `).all();
    }

    case 'Learned':
      return await db.prepare('SELECT * FROM cards WHERE learned = 1 ORDER BY created_at DESC').all();

    default:
      return [];
  }
}

async function getSmartGroupCount(name) {
  switch (name) {
    case 'All Cards':
      return (await db.prepare('SELECT COUNT(*)::int AS n FROM cards WHERE learned = 0').get()).n;
    case 'New Cards':
      return (await db.prepare(`
        SELECT COUNT(*)::int AS n
        FROM cards c
        LEFT JOIN study_log sl ON sl.card_id = c.id
        WHERE sl.id IS NULL AND c.learned = 0
      `).get()).n;
    case 'Recent Mistakes':
      return (await db.prepare(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT c.id
          FROM cards c
          JOIN study_log sl ON sl.card_id = c.id
          WHERE sl.correct = 0 AND sl.studied_at >= datetime('now', '-7 days') AND c.learned = 0
          GROUP BY c.id
        ) t
      `).get()).n;
    case 'Struggling':
      return (await db.prepare(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT c.id
          FROM cards c
          LEFT JOIN study_log sl ON sl.card_id = c.id
          WHERE c.learned = 0
          GROUP BY c.id
          HAVING COUNT(sl.id) >= 3
            AND (SUM(CASE WHEN sl.correct = 1 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(sl.id), 0)) < 0.5
        ) t
      `).get()).n;
    case 'Mastered':
      return (await db.prepare(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT c.id
          FROM cards c
          LEFT JOIN study_log sl ON sl.card_id = c.id
          WHERE c.learned = 0
          GROUP BY c.id
          HAVING COUNT(sl.id) >= 5
            AND (SUM(CASE WHEN sl.correct = 1 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(sl.id), 0)) >= 0.8
        ) t
      `).get()).n;
    case 'Learned':
      return (await db.prepare('SELECT COUNT(*)::int AS n FROM cards WHERE learned = 1').get()).n;
    default:
      return 0;
  }
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─── Cards API ──────────────────────────────────────────────────────────────

app.get('/api/cards', asyncRoute(async (req, res) => {
  const showLearned = req.query.learned === '1';
  const includeStats = req.query.stats === '1';
  const cards = showLearned
    ? await db.prepare('SELECT * FROM cards WHERE learned = 1 ORDER BY created_at DESC').all()
    : await db.prepare('SELECT * FROM cards WHERE learned = 0 ORDER BY created_at DESC').all();
  if (!includeStats) {
    res.json(cards);
    return;
  }
  res.json(await attachStats(cards));
}));

app.post('/api/cards', asyncRoute(async (req, res) => {
  const { chinese, pinyin, english } = req.body;
  if (!chinese && !english) return res.status(400).json({ error: 'chinese or english required' });

  let ch = chinese || '';
  let py = pinyin || '';
  let en = english || '';

  if (ch && dictReady && !py) {
    const r = dictLookupChinese(ch);
    py = r.pinyin;
    if (!en) en = r.english;
  }

  const result = await db.prepare('INSERT INTO cards (chinese, pinyin, english) VALUES (?, ?, ?)').run(ch, py, en);
  const newId = result.lastInsertRowid;
  await autoTagCard(db, newId);
  res.json(await db.prepare('SELECT * FROM cards WHERE id = ?').get(newId));
}));

app.put('/api/cards/:id', asyncRoute(async (req, res) => {
  const { chinese, pinyin, english } = req.body;
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  let newChinese = chinese ?? existing.chinese;
  let newPinyin = pinyin ?? existing.pinyin;
  let newEnglish = english ?? existing.english;

  if (chinese && chinese !== existing.chinese && !pinyin && dictReady) {
    const r = dictLookupChinese(chinese);
    newPinyin = r.pinyin;
    if (!newEnglish && r.english) newEnglish = r.english;
  }

  await db.prepare('UPDATE cards SET chinese=?, pinyin=?, english=? WHERE id=?')
    .run(newChinese, newPinyin, newEnglish, id);
  res.json(await db.prepare('SELECT * FROM cards WHERE id = ?').get(id));
}));

app.delete('/api/cards/:id', asyncRoute(async (req, res) => {
  await db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ─── Generate (bulk import) ──────────────────────────────────────────────────

app.post('/api/generate', asyncRoute(async (req, res) => {
  const { text, groupId } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const items = parseInput(text);
  const created = [];
  const insertCard = db.prepare('INSERT INTO cards (chinese, pinyin, english) VALUES (?, ?, ?)');
  const insertCG = db.prepare('INSERT OR IGNORE INTO card_groups (card_id, group_id) VALUES (?, ?)');

  await db.transaction(async () => {
    for (const item of items) {
      if (!item) continue;

      let chinese = '';
      let pinyinStr = '';
      let englishText = '';

      if (isChinese(item)) {
        if (dictReady) {
          const r = dictLookupChinese(item);
          chinese = r.chinese;
          pinyinStr = r.pinyin;
          englishText = r.english;
        } else {
          chinese = item;
        }
      } else if (dictReady) {
        const r = dictLookupEnglish(item);
        if (r) {
          chinese = r.chinese;
          pinyinStr = r.pinyin;
          englishText = r.english;
        } else {
          englishText = item;
        }
      } else {
        englishText = item;
      }

      const result = await insertCard.run(chinese, pinyinStr, englishText);
      const cardId = result.lastInsertRowid;
      await autoTagCard(db, cardId);
      const card = await db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
      created.push(card);

      if (groupId) await insertCG.run(card.id, groupId);
    }
  })();

  res.json({ created });
}));

// ─── Groups API ──────────────────────────────────────────────────────────────

app.get('/api/groups', asyncRoute(async (req, res) => {
  const groups = await db.prepare('SELECT * FROM groups ORDER BY is_smart DESC, created_at ASC').all();
  const customGroupCountRows = await db.prepare(`
    SELECT group_id, COUNT(*)::int AS n
    FROM card_groups
    GROUP BY group_id
  `).all();
  const customCountMap = new Map(customGroupCountRows.map(r => [Number(r.group_id), Number(r.n)]));
  const withCounts = [];
  for (const g of groups) {
    const count = g.is_smart
      ? await getSmartGroupCount(g.name)
      : (customCountMap.get(Number(g.id)) || 0);
    withCounts.push({ ...g, count: Number(count) });
  }
  res.json(withCounts);
}));

app.post('/api/groups', asyncRoute(async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = await db.prepare('INSERT INTO groups (name, color) VALUES (?, ?)').run(name, color || '#4f8ef7');
  res.json(await db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid));
}));

app.delete('/api/groups/:id', asyncRoute(async (req, res) => {
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if (g.is_smart) return res.status(400).json({ error: 'Cannot delete smart groups' });
  await db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/groups/:id/cards', asyncRoute(async (req, res) => {
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });

  const cards = g.is_smart
    ? await resolveSmartGroup(g.name)
    : await db.prepare(`
        SELECT c.* FROM cards c
        JOIN card_groups cg ON cg.card_id = c.id
        WHERE cg.group_id = ? AND c.learned = 0
        ORDER BY c.created_at DESC
      `).all(g.id);

  res.json(await attachStats(cards));
}));

app.post('/api/groups/:id/cards', asyncRoute(async (req, res) => {
  const { cardIds } = req.body;
  const g = await db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if (g.is_smart) return res.status(400).json({ error: 'Cannot manually add to smart groups' });

  const insert = db.prepare('INSERT OR IGNORE INTO card_groups (card_id, group_id) VALUES (?, ?)');
  await db.transaction(async () => {
    for (const id of cardIds || []) await insert.run(id, g.id);
  })();
  res.json({ ok: true });
}));

app.delete('/api/groups/:id/cards/:cardId', asyncRoute(async (req, res) => {
  await db.prepare('DELETE FROM card_groups WHERE group_id = ? AND card_id = ?')
    .run(req.params.id, req.params.cardId);
  res.json({ ok: true });
}));

// ─── Tags API ────────────────────────────────────────────────────────────────

app.get('/api/tags', asyncRoute(async (req, res) => {
  const tags = await db.prepare('SELECT * FROM tags ORDER BY type DESC, sort_order').all();
  const countRows = await db.prepare(`
    SELECT tag_id, COUNT(*)::int AS n
    FROM card_tags
    GROUP BY tag_id
  `).all();
  const countMap = new Map(countRows.map(r => [Number(r.tag_id), Number(r.n)]));
  const withCounts = [];
  for (const t of tags) {
    withCounts.push({ ...t, count: countMap.get(Number(t.id)) || 0 });
  }
  res.json(withCounts);
}));

app.get('/api/tags/:id/cards', asyncRoute(async (req, res) => {
  const tag = await db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!tag) return res.status(404).json({ error: 'Not found' });

  const cards = await db.prepare(`
    SELECT c.* FROM cards c
    JOIN card_tags ct ON ct.card_id = c.id
    WHERE ct.tag_id = ? AND c.learned = 0
    ORDER BY c.created_at DESC
  `).all(tag.id);

  res.json(await attachStats(cards));
}));

app.get('/api/cards/tags-bulk', asyncRoute(async (req, res) => {
  const idsRaw = (req.query.ids || '').toString().trim();
  if (!idsRaw) return res.json({});

  const ids = idsRaw
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);

  if (!ids.length) return res.json({});

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT
      ct.card_id,
      t.*
    FROM card_tags ct
    JOIN tags t ON t.id = ct.tag_id
    WHERE ct.card_id IN (${placeholders})
    ORDER BY t.type DESC, t.sort_order
  `).all(...ids);

  const out = {};
  for (const id of ids) out[id] = [];
  for (const row of rows) {
    out[row.card_id].push({
      id: row.id,
      name: row.name,
      type: row.type,
      color: row.color,
      emoji: row.emoji,
      sort_order: row.sort_order,
    });
  }
  res.json(out);
}));

app.get('/api/cards/:id/tags', asyncRoute(async (req, res) => {
  const tags = await db.prepare(`
    SELECT t.* FROM tags t
    JOIN card_tags ct ON ct.tag_id = t.id
    WHERE ct.card_id = ?
    ORDER BY t.type DESC, t.sort_order
  `).all(req.params.id);
  res.json(tags);
}));

app.put('/api/cards/:id/level', asyncRoute(async (req, res) => {
  const { level } = req.body;
  const tag = await db.prepare("SELECT * FROM tags WHERE name = ? AND type = 'level'").get(level);
  if (!tag) return res.status(400).json({ error: 'Invalid level' });

  const levelRows = await db.prepare("SELECT id FROM tags WHERE type = 'level'").all();
  const levelTagIds = levelRows.map(t => t.id);

  await db.transaction(async () => {
    for (const lid of levelTagIds) {
      await db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(req.params.id, lid);
    }
    await db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(req.params.id, tag.id);
  })();

  res.json({ ok: true });
}));

app.put('/api/cards/:id/learned', asyncRoute(async (req, res) => {
  const learned = req.body.learned ? 1 : 0;
  const result = await db.prepare('UPDATE cards SET learned = ? WHERE id = ?').run(learned, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, learned });
}));

app.put('/api/cards/:id/topics', asyncRoute(async (req, res) => {
  const { tagIds } = req.body;
  if (!Array.isArray(tagIds)) return res.status(400).json({ error: 'tagIds must be an array' });

  const topicRows = await db.prepare("SELECT id FROM tags WHERE type = 'topic'").all();
  const topicTagIds = topicRows.map(t => t.id);

  await db.transaction(async () => {
    for (const tid of topicTagIds) {
      await db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(req.params.id, tid);
    }
    for (const tid of tagIds) {
      await db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(req.params.id, tid);
    }
  })();

  res.json({ ok: true });
}));

// ─── Study API ───────────────────────────────────────────────────────────────

app.post('/api/study', asyncRoute(async (req, res) => {
  const { cardId, correct } = req.body;
  await db.prepare('INSERT INTO study_log (card_id, correct) VALUES (?, ?)').run(cardId, correct ? 1 : 0);
  res.json({ ok: true });
}));

app.get('/api/status', (req, res) => {
  res.json({ dictReady });
});

// ─── Serve frontend ──────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup (local only; Vercel uses the exported app) ─────────────────────

const PORT = process.env.PORT || 3456;

async function startLocal() {
  await dbReady;

  app.listen(PORT, () => {
    console.log(`\nChinese Flashcards running at http://localhost:${PORT}`);
    console.log('Loading dictionary...\n');
  });

  await initDictionary(true);
}

if (require.main === module && !process.env.VERCEL) {
  startLocal().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
} else {
  // On serverless (e.g. Vercel), initialize dictionary when module is loaded.
  initDictionary(false);
}

module.exports = app;
