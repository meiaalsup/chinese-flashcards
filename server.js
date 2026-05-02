const express = require('express');
const path = require('path');
const db = require('./db');
const { autoTagCard } = require('./autotag');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Dict module (ESM, loaded async at startup) ──────────────────────────────

let dictLookupChinese = null;
let dictLookupEnglish = null;
let dictReady = false;

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

function getCardStats(cardId) {
  const total = db.prepare('SELECT COUNT(*) as n FROM study_log WHERE card_id = ?').get(cardId);
  const correct = db.prepare('SELECT COUNT(*) as n FROM study_log WHERE card_id = ? AND correct = 1').get(cardId);
  return { total: total.n, correct: correct.n };
}

function resolveSmartGroup(name) {
  switch (name) {
    case 'All Cards':
      return db.prepare('SELECT * FROM cards WHERE learned = 0 ORDER BY created_at DESC').all();

    case 'New Cards':
      return db.prepare(`
        SELECT c.* FROM cards c
        LEFT JOIN study_log sl ON sl.card_id = c.id
        WHERE sl.id IS NULL AND c.learned = 0
        ORDER BY c.created_at DESC
      `).all();

    case 'Recent Mistakes':
      return db.prepare(`
        SELECT DISTINCT c.* FROM cards c
        JOIN study_log sl ON sl.card_id = c.id
        WHERE sl.correct = 0 AND sl.studied_at >= datetime('now', '-7 days') AND c.learned = 0
        ORDER BY sl.studied_at DESC
      `).all();

    case 'Struggling': {
      const all = db.prepare('SELECT * FROM cards WHERE learned = 0').all();
      return all.filter(c => {
        const s = getCardStats(c.id);
        return s.total >= 3 && (s.correct / s.total) < 0.5;
      });
    }

    case 'Mastered': {
      const all = db.prepare('SELECT * FROM cards WHERE learned = 0').all();
      return all.filter(c => {
        const s = getCardStats(c.id);
        return s.total >= 5 && (s.correct / s.total) >= 0.8;
      });
    }

    case 'Learned':
      return db.prepare('SELECT * FROM cards WHERE learned = 1 ORDER BY created_at DESC').all();

    default:
      return [];
  }
}

// ─── Cards API ──────────────────────────────────────────────────────────────

app.get('/api/cards', (req, res) => {
  const showLearned = req.query.learned === '1';
  const cards = showLearned
    ? db.prepare('SELECT * FROM cards WHERE learned = 1 ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM cards WHERE learned = 0 ORDER BY created_at DESC').all();
  res.json(cards.map(c => ({ ...c, stats: getCardStats(c.id) })));
});

app.post('/api/cards', (req, res) => {
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

  const result = db.prepare('INSERT INTO cards (chinese, pinyin, english) VALUES (?, ?, ?)').run(ch, py, en);
  const newId = result.lastInsertRowid;
  autoTagCard(newId);
  res.json(db.prepare('SELECT * FROM cards WHERE id = ?').get(newId));
});

app.put('/api/cards/:id', (req, res) => {
  const { chinese, pinyin, english } = req.body;
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  let newChinese = chinese ?? existing.chinese;
  let newPinyin = pinyin ?? existing.pinyin;
  let newEnglish = english ?? existing.english;

  // If chinese changed and no explicit pinyin provided, re-derive
  if (chinese && chinese !== existing.chinese && !pinyin && dictReady) {
    const r = dictLookupChinese(chinese);
    newPinyin = r.pinyin;
    if (!newEnglish && r.english) newEnglish = r.english;
  }

  db.prepare('UPDATE cards SET chinese=?, pinyin=?, english=? WHERE id=?')
    .run(newChinese, newPinyin, newEnglish, id);
  res.json(db.prepare('SELECT * FROM cards WHERE id = ?').get(id));
});

app.delete('/api/cards/:id', (req, res) => {
  db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Generate (bulk import) ──────────────────────────────────────────────────

app.post('/api/generate', (req, res) => {
  const { text, groupId } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const items = parseInput(text);
  const created = [];
  const insertCard = db.prepare('INSERT INTO cards (chinese, pinyin, english) VALUES (?, ?, ?)');
  const insertCG = db.prepare('INSERT OR IGNORE INTO card_groups (card_id, group_id) VALUES (?, ?)');

  const insertMany = db.transaction(() => {
    for (const item of items) {
      if (!item) continue;

      let chinese = '', pinyinStr = '', english = '';

      if (isChinese(item)) {
        if (dictReady) {
          const r = dictLookupChinese(item);
          chinese = r.chinese;
          pinyinStr = r.pinyin;
          english = r.english;
        } else {
          chinese = item;
        }
      } else {
        // English input — attempt reverse lookup
        if (dictReady) {
          const r = dictLookupEnglish(item);
          if (r) {
            chinese = r.chinese;
            pinyinStr = r.pinyin;
            english = r.english;
          } else {
            // Dictionary miss: store as English-only card, leave Chinese/pinyin blank
            english = item;
          }
        } else {
          english = item;
        }
      }

      const result = insertCard.run(chinese, pinyinStr, english);
      const cardId = result.lastInsertRowid;
      autoTagCard(cardId);
      const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
      created.push(card);

      if (groupId) insertCG.run(card.id, groupId);
    }
  });

  insertMany();
  res.json({ created });
});

// ─── Groups API ──────────────────────────────────────────────────────────────

app.get('/api/groups', (req, res) => {
  const groups = db.prepare('SELECT * FROM groups ORDER BY is_smart DESC, created_at ASC').all();
  const withCounts = groups.map(g => {
    const count = g.is_smart
      ? resolveSmartGroup(g.name).length
      : db.prepare('SELECT COUNT(*) as n FROM card_groups WHERE group_id = ?').get(g.id).n;
    return { ...g, count };
  });
  res.json(withCounts);
});

app.post('/api/groups', (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = db.prepare('INSERT INTO groups (name, color) VALUES (?, ?)').run(name, color || '#4f8ef7');
  res.json(db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid));
});

app.delete('/api/groups/:id', (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if (g.is_smart) return res.status(400).json({ error: 'Cannot delete smart groups' });
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/groups/:id/cards', (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });

  const cards = g.is_smart
    ? resolveSmartGroup(g.name)
    : db.prepare(`
        SELECT c.* FROM cards c
        JOIN card_groups cg ON cg.card_id = c.id
        WHERE cg.group_id = ? AND c.learned = 0
        ORDER BY c.created_at DESC
      `).all(g.id);

  res.json(cards.map(c => ({ ...c, stats: getCardStats(c.id) })));
});

app.post('/api/groups/:id/cards', (req, res) => {
  const { cardIds } = req.body;
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if (g.is_smart) return res.status(400).json({ error: 'Cannot manually add to smart groups' });

  const insert = db.prepare('INSERT OR IGNORE INTO card_groups (card_id, group_id) VALUES (?, ?)');
  db.transaction(() => { for (const id of cardIds) insert.run(id, g.id); })();
  res.json({ ok: true });
});

app.delete('/api/groups/:id/cards/:cardId', (req, res) => {
  db.prepare('DELETE FROM card_groups WHERE group_id = ? AND card_id = ?')
    .run(req.params.id, req.params.cardId);
  res.json({ ok: true });
});

// ─── Tags API ────────────────────────────────────────────────────────────────

app.get('/api/tags', (req, res) => {
  const tags = db.prepare('SELECT * FROM tags ORDER BY type DESC, sort_order').all();
  const withCounts = tags.map(t => {
    const { n } = db.prepare('SELECT COUNT(*) as n FROM card_tags WHERE tag_id = ?').get(t.id);
    return { ...t, count: n };
  });
  res.json(withCounts);
});

app.get('/api/tags/:id/cards', (req, res) => {
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!tag) return res.status(404).json({ error: 'Not found' });

  const cards = db.prepare(`
    SELECT c.* FROM cards c
    JOIN card_tags ct ON ct.card_id = c.id
    WHERE ct.tag_id = ? AND c.learned = 0
    ORDER BY c.created_at DESC
  `).all(tag.id);

  res.json(cards.map(c => ({ ...c, stats: getCardStats(c.id) })));
});

// Get tags for a specific card
app.get('/api/cards/:id/tags', (req, res) => {
  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN card_tags ct ON ct.tag_id = t.id
    WHERE ct.card_id = ?
    ORDER BY t.type DESC, t.sort_order
  `).all(req.params.id);
  res.json(tags);
});

// Update a card's level tag
app.put('/api/cards/:id/level', (req, res) => {
  const { level } = req.body;
  const tag = db.prepare("SELECT * FROM tags WHERE name = ? AND type = 'level'").get(level);
  if (!tag) return res.status(400).json({ error: 'Invalid level' });

  const levelTagIds = db.prepare("SELECT id FROM tags WHERE type = 'level'").all().map(t => t.id);

  db.transaction(() => {
    for (const lid of levelTagIds) {
      db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(req.params.id, lid);
    }
    db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(req.params.id, tag.id);
  })();

  res.json({ ok: true });
});

// Mark / unmark a card as learned
app.put('/api/cards/:id/learned', (req, res) => {
  const learned = req.body.learned ? 1 : 0;
  const result = db.prepare('UPDATE cards SET learned = ? WHERE id = ?').run(learned, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, learned });
});

// Replace all topic tags for a card
app.put('/api/cards/:id/topics', (req, res) => {
  const { tagIds } = req.body; // array of topic tag IDs to apply
  if (!Array.isArray(tagIds)) return res.status(400).json({ error: 'tagIds must be an array' });

  const topicTagIds = db.prepare("SELECT id FROM tags WHERE type = 'topic'").all().map(t => t.id);

  db.transaction(() => {
    for (const tid of topicTagIds) {
      db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(req.params.id, tid);
    }
    for (const tid of tagIds) {
      db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(req.params.id, tid);
    }
  })();

  res.json({ ok: true });
});

// ─── Study API ───────────────────────────────────────────────────────────────

app.post('/api/study', (req, res) => {
  const { cardId, correct } = req.body;
  db.prepare('INSERT INTO study_log (card_id, correct) VALUES (?, ?)').run(cardId, correct ? 1 : 0);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ dictReady });
});

// ─── Serve frontend ──────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3456;

async function start() {
  // Start server immediately so the UI is available while the dictionary loads
  app.listen(PORT, () => {
    console.log(`\nChinese Flashcards running at http://localhost:${PORT}`);
    console.log('Loading dictionary...\n');
  });

  try {
    const dict = await import('./dict.mjs');
    dictLookupChinese = dict.lookupChinese;
    dictLookupEnglish = dict.lookupEnglish;
    dictReady = true;
    console.log('Dictionary loaded. Auto-lookup is ready.\n');
  } catch (err) {
    console.error('Dictionary failed to load:', err.message);
    console.log('Pinyin and translations will need to be entered manually.\n');
  }
}

start();
