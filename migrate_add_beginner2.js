/**
 * Adds "Beginner 2" level between Beginner and Intermediate 1.
 * Moves the most high-frequency, foundational words from Int 1 → Beginner 2.
 *
 * Beginner 2 criteria:
 *   - Very common in daily Chinese (HSK 2-3 equivalent)
 *   - Simple, clear concept (not nuanced or domain-specific)
 *   - A learner would realistically encounter these in the first 1-3 months
 *
 * Everything left in Intermediate 1 is still common but either more
 * contextual, more nuanced, or more niche.
 */

const db = require('./db');

// Words to promote from Intermediate 1 → Beginner 2
// (high-frequency, foundational everyday vocabulary)
const BEGINNER_2 = [
  // Core nouns — daily life
  '银行',   // bank
  '新闻',   // news
  '消息',   // information / message
  '短信',   // text message
  '视频',   // video
  '价格',   // price
  '预算',   // budget
  '内容',   // content
  '情况',   // situation
  '理由',   // reason
  '措施',   // measure / step

  // People & work
  '助理',   // assistant
  '员工',   // staff / employee
  '客户',   // client / customer
  '房东',   // landlord
  '租金',   // rent (amount)
  '用户',   // user

  // Objects / tech basics
  '软件',   // software
  '硬件',   // hardware
  '设备',   // equipment
  '数据',   // data
  '电池',   // battery
  '地板',   // floor
  '家具',   // furniture
  '机器',   // machine
  '家电',   // household appliances
  '空调',   // air conditioning
  '订单',   // order (record)
  '水瓶',   // water bottle

  // Common adjectives / descriptors
  '天然',   // natural
  '单独',   // alone / separately
  '巨大',   // huge

  // Everyday actions / verbs
  '发现',   // to discover
  '解决',   // to solve
  '考虑',   // to consider
  '努力',   // to strive / hard-working
  '禁止',   // to prohibit
  '支持',   // to support
  '享受',   // to enjoy
  '失去',   // to lose
  '后悔',   // to regret
  '节省',   // to save
  '升级',   // to upgrade
  '登录',   // to log in
  '结账',   // to pay the bill
  '支付',   // to pay (formal)
  '打折',   // to give a discount
  '优惠',   // discount / favorable
  '延迟',   // delay
  '破坏',   // to destroy / damage
  '迟到',   // to arrive late
  '打扫',   // to clean
  '包含',   // to contain
  '堵车',   // traffic jam
  '分析',   // to analyze

  // Common experiences
  '经验',   // experience (learned)
  '经历',   // experience (events lived)
  '比赛',   // competition
  '战争',   // war
  '列车',   // train
  '丰富',   // rich / plentiful
  '疫苗',   // vaccine

  // Quantities / qualities
  '数量',   // quantity / amount
  '质量',   // quality
  '风险',   // risk
];

db.transaction(() => {
  // 1. Create Beginner 2 tag (between Beginner sort_order=20 and Int 1 sort_order=22)
  db.prepare(`
    INSERT OR IGNORE INTO tags (name, type, color, emoji, sort_order)
    VALUES ('Beginner 2', 'level', '#22d3ee', '🔰', 21)
  `).run();

  const beg2Id = db.prepare("SELECT id FROM tags WHERE name = 'Beginner 2'").get().id;
  const levelIds = db.prepare("SELECT id FROM tags WHERE type = 'level'").all().map(t => t.id);

  let moved = 0;
  for (const zh of BEGINNER_2) {
    const rows = db.prepare('SELECT id FROM cards WHERE chinese = ?').all(zh);
    for (const r of rows) {
      for (const lid of levelIds) {
        db.prepare('DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?').run(r.id, lid);
      }
      db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(r.id, beg2Id);
      moved++;
    }
  }
  console.log(`Moved ${moved} cards to Beginner 2`);
})();

console.log('\n=== Final Level Counts ===');
const levels = ['Beginner', 'Beginner 2', 'Intermediate 1', 'Intermediate 2', 'Advanced', 'Specialized'];
for (const lv of levels) {
  const { n } = db.prepare(`
    SELECT COUNT(*) as n FROM card_tags ct
    JOIN tags t ON t.id = ct.tag_id WHERE t.name = ?
  `).get(lv);
  console.log(`  ${lv}: ${n}`);
}
console.log('\nDone.');
