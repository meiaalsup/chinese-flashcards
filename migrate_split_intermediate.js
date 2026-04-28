/**
 * Splits "Intermediate" into "Intermediate 1" and "Intermediate 2".
 * - Intermediate 1: English definition is 1-3 words (simpler, single-concept)
 * - Intermediate 2: English definition is 4+ words (phrase, more complex meaning)
 *
 * Also updates autotag.js heuristic to use the new levels.
 */

const db = require('./db');

db.transaction(() => {
  // 1. Insert the two new level tags (or ignore if they already exist)
  db.prepare(`
    INSERT OR IGNORE INTO tags (name, type, color, emoji, sort_order)
    VALUES
      ('Intermediate 1', 'level', '#3b82f6', '🔵', 22),
      ('Intermediate 2', 'level', '#8b5cf6', '🟣', 23)
  `).run();

  const getTagId = name => db.prepare('SELECT id FROM tags WHERE name = ?').get(name)?.id;
  const intId  = getTagId('Intermediate');
  const int1Id = getTagId('Intermediate 1');
  const int2Id = getTagId('Intermediate 2');

  if (!intId || !int1Id || !int2Id) {
    console.error('Could not find tag IDs. Aborting.');
    process.exit(1);
  }

  // 2. Fetch all cards currently tagged Intermediate
  const cards = db.prepare(`
    SELECT c.* FROM cards c
    JOIN card_tags ct ON ct.card_id = c.id
    WHERE ct.tag_id = ?
  `).all(intId);

  console.log(`Found ${cards.length} Intermediate cards to re-tag.`);

  let count1 = 0, count2 = 0;

  for (const card of cards) {
    const wordCount = (card.english || '').trim().split(/\s+/).length;
    const newTagId  = wordCount <= 3 ? int1Id : int2Id;

    // Remove old Intermediate tag
    db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(card.id, intId);
    // Add new tag
    db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(card.id, newTagId);

    if (newTagId === int1Id) count1++; else count2++;
  }

  console.log(`Intermediate 1: ${count1} cards`);
  console.log(`Intermediate 2: ${count2} cards`);

  // 3. Delete the old Intermediate tag (no cards reference it now)
  db.prepare('DELETE FROM tags WHERE id = ?').run(intId);
  console.log('Deleted old "Intermediate" tag.');
})();

console.log('Done.');
