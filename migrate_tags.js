/**
 * One-time migration: deduplicate cards, seed tags, auto-tag all existing cards.
 * Safe to re-run (idempotent via INSERT OR IGNORE).
 */

const db = require('./sqlite-migrate-db');

// ── 1. Remove duplicates ──────────────────────────────────────────────────────
// Strategy: keep the lower id (earlier entry), migrate study_log refs, delete dupe.

function dedup(keepId, removeId) {
  const keep   = db.prepare('SELECT * FROM cards WHERE id = ?').get(keepId);
  const remove = db.prepare('SELECT * FROM cards WHERE id = ?').get(removeId);
  if (!keep || !remove) return;

  console.log(`Dedup: keeping ${keepId} (${keep.chinese}), removing ${removeId}`);

  db.transaction(() => {
    // Move study_log entries to the kept card
    db.prepare('UPDATE study_log SET card_id = ? WHERE card_id = ?').run(keepId, removeId);
    // Move group memberships (if not already there)
    db.prepare(`
      INSERT OR IGNORE INTO card_groups (card_id, group_id)
      SELECT ?, group_id FROM card_groups WHERE card_id = ?
    `).run(keepId, removeId);
    // Delete the duplicate
    db.prepare('DELETE FROM cards WHERE id = ?').run(removeId);
  })();
}

// Pairs: [keepId, removeId]
const duplicates = [
  [115, 138], // 经济舱 — keep 115, remove 138 (138 is in veronica-week1; transfer membership)
  [146, 185], // 入住   — keep 146, remove 185 (both in veronica-week1)
  [36,  232], // 数据
  [37,  231], // 实验
];

// Special: 138 is in veronica-week1 but 115 is not — so keep 138 and remove 115 instead
// Re-check which one is in veronica group
const veronicaGroup = db.prepare("SELECT id FROM groups WHERE name = 'veronica-week1-online'").get();
if (veronicaGroup) {
  const inGroup = id => !!db.prepare('SELECT 1 FROM card_groups WHERE card_id = ? AND group_id = ?').get(id, veronicaGroup.id);
  duplicates[0] = inGroup(138) ? [138, 115] : [115, 138]; // keep whichever is in the class group
}

for (const [keep, remove] of duplicates) dedup(keep, remove);

// ── 2. Seed level tags ────────────────────────────────────────────────────────

const levelTags = [
  { name: 'Beginner',     type: 'level', color: '#22c55e', emoji: '⭐',      sort_order: 1 },
  { name: 'Intermediate', type: 'level', color: '#3b82f6', emoji: '⭐⭐',    sort_order: 2 },
  { name: 'Advanced',     type: 'level', color: '#f97316', emoji: '⭐⭐⭐',  sort_order: 3 },
  { name: 'Specialized',  type: 'level', color: '#ef4444', emoji: '⭐⭐⭐⭐', sort_order: 4 },
];

const topicTags = [
  { name: 'Tech & Computers',    type: 'topic', color: '#6366f1', emoji: '💻', sort_order: 10 },
  { name: 'Science & Biology',   type: 'topic', color: '#10b981', emoji: '🧬', sort_order: 11 },
  { name: 'Cafe & Drinks',       type: 'topic', color: '#f59e0b', emoji: '☕', sort_order: 12 },
  { name: 'Food & Vegetables',   type: 'topic', color: '#84cc16', emoji: '🥦', sort_order: 13 },
  { name: 'Travel & Transport',  type: 'topic', color: '#06b6d4', emoji: '✈️', sort_order: 14 },
  { name: 'Shopping & Payments', type: 'topic', color: '#ec4899', emoji: '🛍️', sort_order: 15 },
  { name: 'Housing & Rentals',   type: 'topic', color: '#8b5cf6', emoji: '🏠', sort_order: 16 },
  { name: 'Employment & Work',   type: 'topic', color: '#64748b', emoji: '💼', sort_order: 17 },
  { name: 'Medical & Health',    type: 'topic', color: '#f43f5e', emoji: '🏥', sort_order: 18 },
  { name: 'Emotions & Abstract', type: 'topic', color: '#a78bfa', emoji: '💭', sort_order: 19 },
  { name: 'Internet Slang',      type: 'topic', color: '#fb923c', emoji: '📱', sort_order: 20 },
  { name: 'General',             type: 'topic', color: '#94a3b8', emoji: '📚', sort_order: 21 },
];

const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name, type, color, emoji, sort_order) VALUES (?, ?, ?, ?, ?)');
for (const t of [...levelTags, ...topicTags]) {
  insertTag.run(t.name, t.type, t.color, t.emoji, t.sort_order);
}

// Fetch tag ids
const tagByName = {};
db.prepare('SELECT * FROM tags').all().forEach(t => { tagByName[t.name] = t; });

// ── 3. Manual topic assignments for existing cards ────────────────────────────
// Map: card id → [topic tag names]

const topicMap = {
  // Tech & Computers
  15: ['Tech & Computers'],   // 硬件 hardware
  16: ['Tech & Computers'],   // 软件 software
  17: ['Tech & Computers'],   // 全屏 fullscreen
  18: ['Tech & Computers'],   // 退出 quit/log out
  38: ['Tech & Computers'],   // 程序 program
  39: ['Tech & Computers'],   // 调试 debug
  40: ['Tech & Computers'],   // 芯片 chip
  41: ['Tech & Computers'],   // 电池 battery
  66: ['Tech & Computers'],   // 短信 SMS
  67: ['Tech & Computers'],   // 暂停 pause
  79: ['Tech & Computers'],   // 闪卡 flashcard
  201: ['Tech & Computers'],  // 录制 record
  202: ['Tech & Computers'],  // 视频 video
  203: ['Tech & Computers'],  // 卡 lagging
  204: ['Tech & Computers'],  // 解决 solve
  192: ['Tech & Computers'],  // 断网 internet down
  195: ['Tech & Computers'],  // 延迟 delay/ping
  196: ['Tech & Computers'],  // 网速 internet speed

  // Science & Biology
  32:  ['Science & Biology'],  // 实验室 laboratory
  33:  ['Science & Biology'],  // 培养 cultivate
  34:  ['Science & Biology'],  // 细胞 cell
  35:  ['Science & Biology'],  // 传感器 sensor
  36:  ['Science & Biology', 'Tech & Computers'],  // 数据 data
  37:  ['Science & Biology'],  // 实验 experiment
  77:  ['Science & Biology'],  // 生物反应器 bioreactor
  216: ['Science & Biology'],  // 基因学 genetics
  217: ['Science & Biology'],  // 胚胎 embryo
  218: ['Science & Biology'],  // 囊胚 blastocyst
  219: ['Science & Biology'],  // 试管婴儿 IVF
  220: ['Science & Biology'],  // 取卵 egg retrieval
  221: ['Science & Biology'],  // 冷冻胚胎 frozen embryo
  222: ['Science & Biology'],  // 基因 gene
  223: ['Science & Biology'],  // 遗传学 genetics
  224: ['Science & Biology'],  // 基因型 genotype
  225: ['Science & Biology'],  // 表现型 phenotype
  226: ['Science & Biology'],  // 基因检测 genetic testing
  227: ['Science & Biology'],  // 检测 detect/test
  228: ['Science & Biology'],  // 遗传 heredity
  229: ['Science & Biology'],  // 性状 character/trait
  230: ['Science & Biology'],  // 质量 quality
  233: ['Science & Biology'],  // 分析 analysis
  234: ['Science & Biology'],  // 现场 scene/site
  235: ['Science & Biology'],  // 数量 quantity
  236: ['Science & Biology'],  // 风险 risk

  // Cafe & Drinks
  19:  ['Cafe & Drinks'],  // 拿铁 latte
  26:  ['Cafe & Drinks'],  // 风味 flavor
  27:  ['Cafe & Drinks'],  // 限定 limited
  28:  ['Cafe & Drinks'],  // 热饮 hot drink
  29:  ['Cafe & Drinks'],  // 绵密 meticulous
  30:  ['Cafe & Drinks'],  // 天然 natural
  68:  ['Cafe & Drinks'],  // 去冰 no ice
  69:  ['Cafe & Drinks'],  // 芭乐 guava
  70:  ['Cafe & Drinks'],  // 仙草 grass jelly

  // Food & Vegetables
  43:  ['Food & Vegetables'],  // 胡萝卜 carrot
  44:  ['Food & Vegetables'],  // 地瓜 sweet potato
  45:  ['Food & Vegetables'],  // 大蒜 garlic
  46:  ['Food & Vegetables'],  // 土豆 potato
  47:  ['Food & Vegetables'],  // 青瓜 cucumber
  48:  ['Food & Vegetables'],  // 香菇 shiitake
  49:  ['Food & Vegetables'],  // 南瓜 pumpkin
  50:  ['Food & Vegetables'],  // 玉米 corn
  51:  ['Food & Vegetables'],  // 花菜 cauliflower

  // Travel & Transport
  73:  ['Travel & Transport'],  // 列车 train
  114: ['Travel & Transport'],  // 头等舱 first class
  115: ['Travel & Transport'],  // 经济舱 economy class
  136: ['Travel & Transport'],  // 商务舱 business class
  137: ['Travel & Transport'],  // 升级 upgrade
  139: ['Travel & Transport'],  // 超售 overbooking

  // Shopping & Payments
  52:  ['Shopping & Payments'],  // 节省 save
  124: ['Shopping & Payments'],  // 优惠 discount
  125: ['Shopping & Payments'],  // 团购券 group buying
  126: ['Shopping & Payments'],  // 领券 coupon
  127: ['Shopping & Payments'],  // 价格 price
  128: ['Shopping & Payments'],  // 支持 support
  129: ['Shopping & Payments'],  // 支付宝 Alipay
  130: ['Shopping & Payments'],  // 支付 pay
  131: ['Shopping & Payments'],  // 买一送一 BOGO
  132: ['Shopping & Payments'],  // 打折 discount
  133: ['Shopping & Payments'],  // 结账 pay bill
  134: ['Shopping & Payments'],  // 额外 extra
  135: ['Shopping & Payments'],  // 费用 cost
  161: ['Shopping & Payments'],  // 讨价还价 haggle
  197: ['Shopping & Payments'],  // 砍价 bargain
  200: ['Shopping & Payments'],  // 省钱 save money

  // Housing & Rentals
  140: ['Housing & Rentals'],  // 大床房 double bed
  141: ['Housing & Rentals'],  // 户型 room type
  142: ['Housing & Rentals'],  // 单间 studio
  143: ['Housing & Rentals'],  // 一室一厅 1BR 1LR
  144: ['Housing & Rentals'],  // 两室一厅 2BR 1LR
  145: ['Housing & Rentals'],  // 报告 report
  146: ['Housing & Rentals'],  // 入住 check in
  147: ['Housing & Rentals'],  // 报价格 quote price
  148: ['Housing & Rentals'],  // 客户 client
  149: ['Housing & Rentals'],  // 一户人家 a family
  150: ['Housing & Rentals'],  // 平 sqm
  153: ['Housing & Rentals'],  // 地板 floor
  156: ['Housing & Rentals'],  // 发型 hairstyle (actually misc, but in the week)
  157: ['Housing & Rentals'],  // 新手保护期 grace period
  158: ['Housing & Rentals'],  // 水电物业费 utilities fee
  159: ['Housing & Rentals'],  // 助理 assistant
  160: ['Housing & Rentals'],  // 打扫 clean
  162: ['Housing & Rentals'],  // 隔音 soundproofing
  163: ['Housing & Rentals'],  // 空调 AC
  167: ['Housing & Rentals'],  // 租房 rent apartment
  168: ['Housing & Rentals'],  // 租金 rent $
  169: ['Housing & Rentals'],  // 押金 deposit
  170: ['Housing & Rentals'],  // 押一付三 1-month-3-month
  171: ['Housing & Rentals'],  // 单人房 single room
  172: ['Housing & Rentals'],  // 双人房 double room
  173: ['Housing & Rentals'],  // 家电 appliances
  174: ['Housing & Rentals'],  // 家具 furniture
  175: ['Housing & Rentals'],  // 短租 short term
  176: ['Housing & Rentals'],  // 租期 lease term
  177: ['Housing & Rentals'],  // 网费 internet fee
  178: ['Housing & Rentals'],  // 物业费 property mgmt fee
  179: ['Housing & Rentals'],  // 缴纳 pay
  180: ['Housing & Rentals'],  // 到期 expire
  181: ['Housing & Rentals'],  // 退还 refund
  182: ['Housing & Rentals'],  // 齐全 complete
  183: ['Housing & Rentals'],  // 单独 alone
  184: ['Housing & Rentals'],  // 禁止 prohibit
  186: ['Housing & Rentals'],  // 退房 check out
  187: ['Housing & Rentals'],  // 退租 stop leasing
  188: ['Housing & Rentals'],  // 级别 level/rank
  189: ['Housing & Rentals'],  // 水平 skill level
  190: ['Housing & Rentals'],  // 省电 save electricity
  191: ['Housing & Rentals'],  // 费电 uses electricity
  193: ['Housing & Rentals'],  // 立即上门 on-site service
  194: ['Housing & Rentals'],  // 预算 budget
  198: ['Housing & Rentals'],  // 物业 property mgmt
  199: ['Housing & Rentals'],  // 房东 landlord

  // Employment & Work
  205: ['Employment & Work'],  // 为…工作 work for
  206: ['Employment & Work'],  // 雇 hire
  207: ['Employment & Work'],  // 员工 employee
  208: ['Employment & Work'],  // 雇佣关系 employment relation
  209: ['Employment & Work'],  // 佣人 servant
  210: ['Employment & Work'],  // 菲佣 Filipino maid
  211: ['Employment & Work'],  // 奴隶 slave
  212: ['Employment & Work'],  // 努力 try hard
  213: ['Employment & Work'],  // 黑奴 black slave

  // Medical & Health
  55:  ['Medical & Health'],  // 疫苗 vaccine
  57:  ['Medical & Health'],  // 胳膊 arm
  58:  ['Medical & Health'],  // 手指 finger
  59:  ['Medical & Health'],  // 健身房 gym
  151: ['Medical & Health'],  // 拐杖 crutches
  152: ['Medical & Health'],  // 支具 cast/brace
  154: ['Medical & Health'],  // 滑 slippery
  155: ['Medical & Health'],  // 摔倒 fall down
  164: ['Medical & Health'],  // 痊愈 recover
  165: ['Medical & Health'],  // 治愈 cure
  166: ['Medical & Health'],  // 治病 treat illness

  // Emotions & Abstract
  56:  ['Emotions & Abstract'],  // 温柔 gentle
  78:  ['Emotions & Abstract'],  // 恼火 annoyed
  93:  ['Emotions & Abstract'],  // 依稀 vaguely
  99:  ['Emotions & Abstract'],  // 刻意 intentionally
  100: ['Emotions & Abstract'],  // 回憶 reminisce
  101: ['Emotions & Abstract'],  // 激烈 intense
  103: ['Emotions & Abstract'],  // 享受 enjoy
  105: ['Emotions & Abstract'],  // 理由 reason
  107: ['Emotions & Abstract'],  // 寂寞 lonely
  108: ['Emotions & Abstract'],  // 难耐 unbearable
  109: ['Emotions & Abstract'],  // 渴望 yearn
  110: ['Emotions & Abstract'],  // 一个谎言 a lie
  111: ['Emotions & Abstract'],  // 善意 goodwill
  112: ['Emotions & Abstract'],  // 謊 lie
  116: ['Emotions & Abstract'],  // 哀 sorrow
  117: ['Emotions & Abstract'],  // 消息 news/info
  122: ['Emotions & Abstract'],  // 失去 to lose
  123: ['Emotions & Abstract'],  // 巨大 huge

  // Internet Slang
  94:  ['Internet Slang'],  // 釣魚 fishing
  95:  ['Internet Slang'],  // 釣魚文 troll post
  96:  ['Internet Slang'],  // 上勾 take bait
  102: ['Internet Slang'],  // 選秀 talent show
  104: ['Internet Slang'],  // 顯眼 conspicuous

  // General
  54:  ['General'],  // 措施 measure
  64:  ['General'],  // 烘干机 dryer
  65:  ['General'],  // 包含 include
  74:  ['General'],  // 考虑 consider
  75:  ['General'],  // 洗衣机 washing machine
  80:  ['General'],  // 俱 all
  81:  ['General'],  // 曾 once/already
  84:  ['General'],  // 渔捞 fishing
  88:  ['General'],  // 富 rich
  89:  ['General'],  // 比赛 competition
  90:  ['General'],  // 目光 gaze
  97:  ['General'],  // 後 after
  98:  ['General'],  // 撤離 evacuate
  118: ['General'],  // 新闻 news
  119: ['General'],  // 大战 war
  120: ['General'],  // 战争 war/conflict
  121: ['General'],  // 破坏 destruction
  237: ['General'],  // 用户 user
  238: ['General'],  // 早日 soon
};

// ── 4. Level assignments ──────────────────────────────────────────────────────
// B=Beginner, I=Intermediate, A=Advanced, S=Specialized

const levelMap = {
  // Beginner — everyday words a new learner should know early
  43: 'Beginner', 44: 'Beginner', 45: 'Beginner', 46: 'Beginner',
  47: 'Beginner', 48: 'Beginner', 49: 'Beginner', 50: 'Beginner',
  51: 'Beginner', // vegetables
  19: 'Beginner', // latte
  57: 'Beginner', 58: 'Beginner', // arm, finger
  89: 'Beginner', // competition
  66: 'Beginner', // SMS
  73: 'Beginner', // train
  88: 'Beginner', // rich
  163: 'Beginner', // AC
  174: 'Beginner', // furniture
  127: 'Beginner', // price
  212: 'Beginner', // try hard
  204: 'Beginner', // solve
  30: 'Beginner',  // natural
  117: 'Beginner', // news/message
  105: 'Beginner', // reason
  160: 'Beginner', // clean
  74:  'Beginner', // consider
  65:  'Beginner', // include
  183: 'Beginner', // alone
  184: 'Beginner', // prohibit
  237: 'Beginner', // user
  118: 'Beginner', // news

  // Intermediate — conversational, practical adult life vocab
  15: 'Intermediate', 16: 'Intermediate', 17: 'Intermediate', 18: 'Intermediate', // tech basics
  26: 'Intermediate', 27: 'Intermediate', 28: 'Intermediate', 29: 'Intermediate', // cafe vocab
  52: 'Intermediate', // save
  54: 'Intermediate', // measure
  55: 'Intermediate', // vaccine
  56: 'Intermediate', // gentle
  59: 'Intermediate', // gym
  64: 'Intermediate', 75: 'Intermediate', // dryer, washing machine
  67: 'Intermediate', // pause
  68: 'Intermediate', 69: 'Intermediate', 70: 'Intermediate', // cafe specials
  78: 'Intermediate', // annoyed
  79: 'Intermediate', // flashcard
  90: 'Intermediate', // gaze
  93: 'Intermediate', // vaguely
  97: 'Intermediate', 98: 'Intermediate', // after, evacuate
  99: 'Intermediate', // intentionally
  100: 'Intermediate', 101: 'Intermediate', // reminisce, intense
  103: 'Intermediate', // enjoy
  104: 'Intermediate', // conspicuous
  107: 'Intermediate', 108: 'Intermediate', // lonely, unbearable
  109: 'Intermediate', // yearn
  110: 'Intermediate', 111: 'Intermediate', 112: 'Intermediate', // lie, goodwill
  114: 'Intermediate', 115: 'Intermediate', 136: 'Intermediate', // cabin classes
  116: 'Intermediate', // sorrow
  119: 'Intermediate', 120: 'Intermediate', 121: 'Intermediate', // war, destruction
  122: 'Intermediate', 123: 'Intermediate', // lose, huge
  124: 'Intermediate', 125: 'Intermediate', 126: 'Intermediate', // discounts
  128: 'Intermediate', 130: 'Intermediate', 131: 'Intermediate', // payment vocab
  132: 'Intermediate', 133: 'Intermediate', 134: 'Intermediate', 135: 'Intermediate',
  137: 'Intermediate', 139: 'Intermediate', // upgrade, overbooking
  140: 'Intermediate', 141: 'Intermediate', 142: 'Intermediate', // room types
  143: 'Intermediate', 144: 'Intermediate', // room layouts
  145: 'Intermediate', 146: 'Intermediate', 147: 'Intermediate', 148: 'Intermediate',
  149: 'Intermediate', 150: 'Intermediate', // housing vocab
  153: 'Intermediate', 154: 'Intermediate', 155: 'Intermediate', // floor, slip, fall
  156: 'Intermediate', // hairstyle
  159: 'Intermediate', // assistant
  161: 'Intermediate', // haggle
  162: 'Intermediate', // soundproofing
  164: 'Intermediate', 165: 'Intermediate', 166: 'Intermediate', // medical
  167: 'Intermediate', 168: 'Intermediate', 169: 'Intermediate', // rent vocab
  170: 'Intermediate', 171: 'Intermediate', 172: 'Intermediate',
  173: 'Intermediate', 175: 'Intermediate', 176: 'Intermediate', // appliances, short/lease
  177: 'Intermediate', 178: 'Intermediate', 179: 'Intermediate',
  180: 'Intermediate', 181: 'Intermediate', 182: 'Intermediate',
  186: 'Intermediate', 187: 'Intermediate', // check out, stop lease
  188: 'Intermediate', 189: 'Intermediate', // level/rank, skill level
  190: 'Intermediate', 191: 'Intermediate', // save/use electricity
  192: 'Intermediate', 193: 'Intermediate', 194: 'Intermediate', // internet vocab
  195: 'Intermediate', 196: 'Intermediate', 197: 'Intermediate',
  199: 'Intermediate', 200: 'Intermediate', // landlord, save money
  201: 'Intermediate', 202: 'Intermediate', 203: 'Intermediate',
  205: 'Intermediate', 206: 'Intermediate', 207: 'Intermediate',
  209: 'Intermediate', // servant
  80: 'Intermediate', 81: 'Intermediate', // 俱, 曾 (classical)
  84: 'Intermediate', // fishing
  94: 'Intermediate', 95: 'Intermediate', 96: 'Intermediate', // internet slang
  102: 'Intermediate', // talent show
  238: 'Intermediate', // soon (formal)

  // Advanced
  32: 'Advanced', 33: 'Advanced', 34: 'Advanced', 35: 'Advanced', // lab vocab
  36: 'Advanced', 37: 'Advanced', // data, experiment
  38: 'Advanced', 39: 'Advanced', 40: 'Advanced', 41: 'Advanced', // chip, debug, battery, program
  77: 'Advanced', // bioreactor
  129: 'Advanced', // Alipay (ecosystem knowledge)
  151: 'Advanced', 152: 'Advanced', // crutches, cast
  157: 'Advanced', // grace period
  158: 'Advanced', // utilities fee compound
  208: 'Advanced', // employment relationship
  210: 'Advanced', // Filipino maid
  213: 'Advanced', // black slave (historical)
  230: 'Advanced', // quality
  233: 'Advanced', // analyze
  234: 'Advanced', 235: 'Advanced', 236: 'Advanced', // scene, quantity, risk
  198: 'Advanced', // property management

  // Specialized — technical/professional
  216: 'Specialized', 217: 'Specialized', 218: 'Specialized',
  219: 'Specialized', 220: 'Specialized', 221: 'Specialized',
  222: 'Specialized', 223: 'Specialized', 224: 'Specialized',
  225: 'Specialized', 226: 'Specialized', 227: 'Specialized',
  228: 'Specialized', 229: 'Specialized', // genetics terms
  211: 'Specialized', // slave (historical)
  157: 'Specialized', // grace period (very specific concept)
};

// ── 5. Apply tags ─────────────────────────────────────────────────────────────

const insertCardTag = db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)');

const applyTags = db.transaction(() => {
  const allCards = db.prepare('SELECT id FROM cards').all();
  const allIds = new Set(allCards.map(c => c.id));

  for (const [cardIdStr, topics] of Object.entries(topicMap)) {
    const cardId = parseInt(cardIdStr);
    if (!allIds.has(cardId)) continue;
    for (const topic of topics) {
      const tag = tagByName[topic];
      if (tag) insertCardTag.run(cardId, tag.id);
    }
  }

  for (const [cardIdStr, level] of Object.entries(levelMap)) {
    const cardId = parseInt(cardIdStr);
    if (!allIds.has(cardId)) continue;
    const tag = tagByName[level];
    if (tag) insertCardTag.run(cardId, tag.id);
  }

  // Any card without a level tag → Intermediate by default
  const withLevel = new Set(
    db.prepare(`
      SELECT ct.card_id FROM card_tags ct
      JOIN tags t ON t.id = ct.tag_id
      WHERE t.type = 'level'
    `).all().map(r => r.card_id)
  );
  const intermediateId = tagByName['Intermediate']?.id;
  if (intermediateId) {
    for (const { id } of allCards) {
      if (!withLevel.has(id)) insertCardTag.run(id, intermediateId);
    }
  }

  // Any card without a topic tag → General
  const withTopic = new Set(
    db.prepare(`
      SELECT ct.card_id FROM card_tags ct
      JOIN tags t ON t.id = ct.tag_id
      WHERE t.type = 'topic'
    `).all().map(r => r.card_id)
  );
  const generalId = tagByName['General']?.id;
  if (generalId) {
    for (const { id } of allCards) {
      if (!withTopic.has(id)) insertCardTag.run(id, generalId);
    }
  }
});

applyTags();

// ── 6. Summary ────────────────────────────────────────────────────────────────

console.log('\n=== Tag summary ===');
const summary = db.prepare(`
  SELECT t.emoji, t.name, t.type, COUNT(ct.card_id) as n
  FROM tags t
  LEFT JOIN card_tags ct ON ct.tag_id = t.id
  GROUP BY t.id
  ORDER BY t.type DESC, t.sort_order
`).all();

summary.forEach(r => console.log(`  ${r.emoji} ${r.name} (${r.type}): ${r.n} cards`));

const remaining = db.prepare(`SELECT id, chinese FROM cards WHERE id NOT IN (SELECT DISTINCT card_id FROM card_tags)`).all();
if (remaining.length) console.log('\nUntagged cards:', remaining.map(c => `${c.id}:${c.chinese}`).join(', '));
else console.log('\nAll cards tagged ✓');

console.log('\nMigration complete.');
