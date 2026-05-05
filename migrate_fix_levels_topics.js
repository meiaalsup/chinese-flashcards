/**
 * Comprehensive level + topic corrections.
 *
 * Level philosophy:
 *   Beginner      — single chars or very basic vocabulary (first few weeks)
 *   Intermediate 1 — common 2-char words (daily speech, HSK 2-3 equivalent)
 *   Intermediate 2 — less common 2-char or idiomatic 2-char words (HSK 4-5)
 *   Advanced       — 3-4 char compounds, chengyu, contextual expressions
 *   Specialized    — 5+ chars, heavy domain-specific terminology
 *
 * Topic corrections:
 *   Remove "Science & Biology" from general words caught by over-broad keywords.
 *   Fix 外表 topic (appearance ≠ science).
 *   Fix keyword list in autotag.js to avoid future mis-tagging.
 */

const db = require('./sqlite-migrate-db');

// ── Helpers ────────────────────────────────────────────────────────────────

const getTagId  = name => db.prepare('SELECT id FROM tags WHERE name = ?').get(name)?.id;
const getCardId = (chinese, english) => {
  const row = db.prepare('SELECT id FROM cards WHERE chinese = ? OR english = ?').get(chinese, english);
  return row?.id;
};
const cardsByEnglish = english =>
  db.prepare('SELECT id FROM cards WHERE english LIKE ?').all(`%${english}%`).map(r => r.id);
const cardsByChinese = chinese =>
  db.prepare('SELECT id FROM cards WHERE chinese = ?').all(chinese).map(r => r.id);

function setLevel(cardIds, levelName) {
  const newId = getTagId(levelName);
  if (!newId) { console.warn(`  ⚠️  Tag not found: ${levelName}`); return; }

  const levelIds = db.prepare("SELECT id FROM tags WHERE type = 'level'").all().map(t => t.id);
  for (const cid of cardIds) {
    for (const lid of levelIds) {
      db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(cid, lid);
    }
    db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(cid, newId);
  }
}

function removeTopicTag(cardIds, topicName) {
  const tid = getTagId(topicName);
  if (!tid) return;
  for (const cid of cardIds) {
    db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(cid, tid);
  }
}

function addTopicTag(cardIds, topicName) {
  const tid = getTagId(topicName);
  if (!tid) { console.warn(`  ⚠️  Topic not found: ${topicName}`); return; }
  for (const cid of cardIds) {
    db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(cid, tid);
  }
}

function ensureGeneralTag(cardIds) {
  // If card has no topic tag after corrections, add General
  const topicIds = db.prepare("SELECT id FROM tags WHERE type = 'topic'").all().map(t => t.id);
  const generalId = getTagId('General');
  for (const cid of cardIds) {
    const hasAny = topicIds.some(tid =>
      db.prepare('SELECT 1 FROM card_tags WHERE card_id = ? AND tag_id = ?').get(cid, tid)
    );
    if (!hasAny && generalId) {
      db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(cid, generalId);
    }
  }
}

// ── Main migration ────────────────────────────────────────────────────────

db.transaction(() => {

  // ════════════════════════════════════════════════════
  // 1. LEVEL FIXES
  // ════════════════════════════════════════════════════

  console.log('\n── Beginner → Intermediate 1 ──');
  const toInt1FromBeginner = [
    '空调','比赛','家具','八卦','天然','新闻','消息',
    '价格','理由','单独','短信','经历','经验','打扫',
    '包含','努力','发现','禁止','解决','考虑','列车','用户',
  ];
  for (const zh of toInt1FromBeginner) {
    const ids = cardsByChinese(zh);
    if (ids.length) { setLevel(ids, 'Intermediate 1'); console.log(`  ✓ ${zh}`); }
    else console.warn(`  ⚠️  not found: ${zh}`);
  }

  console.log('\n── Beginner → Advanced ──');
  {
    const ids = cardsByChinese('算法');
    if (ids.length) { setLevel(ids, 'Advanced'); console.log('  ✓ 算法 (algorithm)'); }
  }

  console.log('\n── Intermediate 1 → Beginner (single chars that are basic) ──');
  for (const zh of ['後']) {
    const ids = cardsByChinese(zh);
    if (ids.length) { setLevel(ids, 'Beginner'); console.log(`  ✓ ${zh}`); }
  }

  console.log('\n── Intermediate 1 → Advanced (3-char compounds) ──');
  const toAdvancedFromInt1 = [
    '头等舱','商务舱','经济舱','烘干机','双人房',
    '物业费','报价格','健身房','团购券','釣魚文',
  ];
  for (const zh of toAdvancedFromInt1) {
    const ids = cardsByChinese(zh);
    if (ids.length) { setLevel(ids, 'Advanced'); console.log(`  ✓ ${zh}`); }
    else console.warn(`  ⚠️  not found: ${zh}`);
  }

  console.log('\n── Intermediate 2 → Intermediate 1 (common 2-char words) ──');
  const toInt1FromInt2 = [
    '优惠','延迟','支持','巨大','温柔','善意','激烈',
    '寂寞','遗憾','享受','丰富','失去','后悔',
    '水平','级别','节省','情况','预测','升级',
    '堵车','营业','租房','退房','打折','登录',
    '结账','暂停','支付','去冰','破坏',
  ];
  for (const zh of toInt1FromInt2) {
    const ids = cardsByChinese(zh);
    if (ids.length) { setLevel(ids, 'Intermediate 1'); console.log(`  ✓ ${zh}`); }
    else console.warn(`  ⚠️  not found: ${zh}`);
  }

  console.log('\n── Intermediate 2 → Advanced (3-4 char compounds) ──');
  const toAdvancedFromInt2 = [
    '立即上门','买一送一','押一付三',
    '一室一厅','两室一厅','讨价还价','大床房',
  ];
  for (const zh of toAdvancedFromInt2) {
    const ids = cardsByChinese(zh);
    if (ids.length) { setLevel(ids, 'Advanced'); console.log(`  ✓ ${zh}`); }
    else console.warn(`  ⚠️  not found: ${zh}`);
  }

  console.log('\n── Advanced → Intermediate 1 (common everyday 2-char words) ──');
  const toInt1FromAdvanced = ['数量','电池','数据','质量','风险','分析'];
  for (const zh of toInt1FromAdvanced) {
    const ids = cardsByChinese(zh);
    if (ids.length) { setLevel(ids, 'Intermediate 1'); console.log(`  ✓ ${zh}`); }
    else console.warn(`  ⚠️  not found: ${zh}`);
  }

  console.log('\n── Advanced → Intermediate 2 (niche 2-char or domain-specific) ──');
  const toInt2FromAdvanced = ['菲佣','黑奴','支具','拐杖','实验','程序','物业','培养','现场'];
  for (const zh of toInt2FromAdvanced) {
    const ids = cardsByChinese(zh);
    if (ids.length) { setLevel(ids, 'Intermediate 2'); console.log(`  ✓ ${zh}`); }
    else console.warn(`  ⚠️  not found: ${zh}`);
  }

  console.log('\n── Advanced → Specialized (5+ chars / ultra-specific) ──');
  for (const zh of ['生物反应器', '水电物业费']) {
    const ids = cardsByChinese(zh);
    if (ids.length) { setLevel(ids, 'Specialized'); console.log(`  ✓ ${zh}`); }
  }

  // ════════════════════════════════════════════════════
  // 2. TOPIC FIXES
  // ════════════════════════════════════════════════════

  console.log('\n── Remove "Science & Biology" from general/misclassified words ──');

  // Words that matched Science only because of over-broad keywords
  // (quantity, quality, risk, analyze, detect, test, research)
  const scienceMisclassified = {
    // ch → correct topic
    '数量': 'General',
    '数据': 'Tech & Computers',
    '质量': 'General',
    '风险': 'General',
    '现场': 'General',
    '分析': 'General',
    '发现': 'General',
    '性':   'General',     // "nature; character" — general suffix, not biology
    '外表': 'Emotions & Abstract',  // "outward appearance" — not science!
  };

  for (const [zh, correctTopic] of Object.entries(scienceMisclassified)) {
    const ids = cardsByChinese(zh);
    if (!ids.length) { console.warn(`  ⚠️  not found: ${zh}`); continue; }
    removeTopicTag(ids, 'Science & Biology');
    addTopicTag(ids, correctTopic);
    console.log(`  ✓ ${zh} → ${correctTopic}`);
  }

  // 培养 stays in Science (legitimately biological + educational)
  // 检测 stays in Science (lab testing context)

  // 性状 (nature; character - inherited) stays in Science ✓

  // Make sure nothing is left with no topic tag
  const allCardIds = db.prepare('SELECT id FROM cards').all().map(r => r.id);
  let fixed = 0;
  for (const cid of allCardIds) {
    const topicIds = db.prepare("SELECT id FROM tags WHERE type = 'topic'").all().map(t => t.id);
    const generalId = getTagId('General');
    const hasAny = topicIds.some(tid =>
      db.prepare('SELECT 1 FROM card_tags WHERE card_id = ? AND tag_id = ?').get(cid, tid)
    );
    if (!hasAny && generalId) {
      db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(cid, generalId);
      fixed++;
    }
  }
  if (fixed) console.log(`\n  Added General tag to ${fixed} orphaned cards`);

})();

// ── Print summary ──────────────────────────────────────────────────────────

console.log('\n\n=== Final Level Counts ===');
const levels = ['Beginner', 'Intermediate 1', 'Intermediate 2', 'Advanced', 'Specialized'];
for (const lv of levels) {
  const { n } = db.prepare(`
    SELECT COUNT(*) as n FROM card_tags ct
    JOIN tags t ON t.id = ct.tag_id WHERE t.name = ?
  `).get(lv);
  console.log(`  ${lv}: ${n}`);
}

console.log('\nDone.');
