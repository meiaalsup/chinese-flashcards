/**
 * Auto-tagging logic for newly generated cards.
 * Called from server.js after a card is created.
 */

const db = require('./db');

// ── Topic keyword matching ──────────────────────────────────────────────────

const TOPIC_KEYWORDS = {
  'Tech & Computers': [
    'software', 'hardware', 'computer', 'chip', 'battery', 'debug', 'program', 'code',
    'data', 'screen', 'fullscreen', 'quit', 'log out', 'sms', 'text message', 'pause',
    'flashcard', 'record', 'video', 'lag', 'lagging', 'frozen', 'solve', 'internet',
    'network', 'speed', 'delay', 'disconnected', 'user', 'sensor', 'app', 'device',
    'download', 'upload', 'wifi', 'signal', 'bluetooth',
  ],
  'Science & Biology': [
    'laboratory', 'lab', 'bioreactor', 'gene', 'genetic', 'genetics', 'genotype',
    'phenotype', 'embryo', 'blastocyst', 'ivf', 'egg retrieval', 'frozen embryo',
    'heredity', 'inherit', 'trait', 'dna', 'rna', 'protein', 'molecule',
    'bacteria', 'virus', 'sperm', 'ovum', 'cell biology', 'genomic',
    'chromosome', 'specimen', 'pathogen',
  ],
  'Cafe & Drinks': [
    'latte', 'coffee', 'tea', 'drink', 'hot drink', 'cold drink', 'juice', 'boba',
    'bubble tea', 'flavor', 'limited', 'natural', 'no ice', 'guava', 'grass jelly',
    'milk', 'sugar', 'cream', 'espresso', 'cappuccino', 'menu', 'order',
  ],
  'Food & Vegetables': [
    'carrot', 'potato', 'garlic', 'cucumber', 'mushroom', 'pumpkin', 'corn', 'cauliflower',
    'sweet potato', 'vegetable', 'fruit', 'food', 'eat', 'meal', 'rice', 'noodle',
    'chicken', 'beef', 'pork', 'fish', 'tofu', 'soup', 'cook', 'restaurant',
  ],
  'Travel & Transport': [
    'train', 'flight', 'airplane', 'plane', 'cabin', 'first class', 'business class',
    'economy class', 'upgrade', 'overbooking', 'ticket', 'hotel', 'check in',
    'check out', 'luggage', 'passport', 'visa', 'transport', 'subway', 'bus',
    'taxi', 'ride', 'trip', 'travel', 'destination',
  ],
  'Shopping & Payments': [
    'discount', 'price', 'pay', 'payment', 'alipay', 'wechat pay', 'coupon',
    'voucher', 'group buying', 'buy one get one', 'bogo', 'bill', 'extra', 'cost',
    'fee', 'save money', 'bargain', 'haggle', 'refund', 'purchase', 'buy', 'sell',
    'shop', 'market', 'sale', 'offer', 'deal', 'budget', 'expense',
  ],
  'Housing & Rentals': [
    'rent', 'apartment', 'room', 'studio', 'bedroom', 'living room', 'floor',
    'landlord', 'tenant', 'deposit', 'lease', 'property', 'furniture', 'appliance',
    'soundproof', 'air conditioning', 'electricity', 'water', 'utilities', 'clean',
    'house', 'home', 'move in', 'move out', 'single room', 'double room',
    'property management', 'short term', 'long term', 'square meter',
  ],
  'Employment & Work': [
    'work', 'job', 'hire', 'employee', 'staff', 'employer', 'salary', 'wage',
    'servant', 'maid', 'slave', 'employment', 'boss', 'manager', 'assistant',
    'colleague', 'intern', 'resign', 'fired', 'promote', 'effort', 'hard-working',
  ],
  'Medical & Health': [
    'vaccine', 'arm', 'finger', 'gym', 'fitness', 'crutch', 'cast', 'brace',
    'slippery', 'fall', 'recover', 'cure', 'treat', 'illness', 'doctor', 'hospital',
    'medicine', 'health', 'injury', 'pain', 'surgery', 'prescription',
  ],
  'Emotions & Abstract': [
    'gentle', 'annoyed', 'lonely', 'lonesome', 'unbearable', 'yearn', 'long for',
    'intense', 'fierce', 'enjoy', 'reason', 'lie', 'goodwill', 'sorrow', 'grief',
    'love', 'hate', 'happy', 'sad', 'angry', 'fear', 'hope', 'dream', 'memory',
    'intentionally', 'deliberately', 'vaguely', 'reminisce', 'conspicuous',
  ],
  'Internet Slang': [
    'troll', 'bait', 'fishing post', 'talent show', 'audition', 'meme', 'viral',
    'clickbait', 'catfish', 'roast', 'stan', 'ghosting',
  ],
};

// ── Level heuristics ────────────────────────────────────────────────────────
// Based on character count and syllable count (rough proxy for complexity)

function guessLevel(chinese, english) {
  const syllableCount = (chinese || '').replace(/[^\u4e00-\u9fff\u3400-\u4dbf]/g, '').length;

  // Specialized: very long compounds or highly technical English
  const technicalTerms = ['genotype', 'phenotype', 'blastocyst', 'bioreactor', 'embryo',
    'heredity', 'genomic', 'genetic testing', 'iq', 'chromosome'];
  if (technicalTerms.some(t => (english || '').toLowerCase().includes(t))) return 'Specialized';
  if (syllableCount >= 5) return 'Specialized';

  // Advanced: 3-4 hanzi compounds
  if (syllableCount >= 3) return 'Advanced';

  // Beginner: single characters with very basic meanings
  const beginnerWords = ['water', 'fire', 'wood', 'hello', 'thank', 'goodbye', 'cat', 'dog',
    'fish', 'bird', 'rice', 'eat', 'drink', 'go', 'come', 'good', 'bad', 'big', 'small',
    'mother', 'father', 'friend', 'student', 'teacher', 'person'];
  if (syllableCount === 1 && beginnerWords.some(w => (english || '').toLowerCase().includes(w))) return 'Beginner';
  if (syllableCount === 1) return 'Beginner 2'; // single chars that aren't ultra-basic

  // 2-char words: split by how common/foundational the concept is
  // Short English definition (1-2 words) = probably a clear, common concept → Beginner 2
  // Longer definition = more nuanced/contextual → Intermediate 1 or 2
  const wordCount = (english || '').trim().split(/\s+/).length;
  if (wordCount <= 2) return 'Beginner 2';
  return wordCount <= 5 ? 'Intermediate 1' : 'Intermediate 2';
}

// ── Main auto-tag function ──────────────────────────────────────────────────

function autoTagCard(cardId) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return;

  const en = (card.english || '').toLowerCase();
  const insertTag = db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)');

  const getTagId = name => db.prepare('SELECT id FROM tags WHERE name = ?').get(name)?.id;

  db.transaction(() => {
    // Topic
    let matched = false;
    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      if (keywords.some(kw => en.includes(kw))) {
        const id = getTagId(topic);
        if (id) { insertTag.run(cardId, id); matched = true; }
      }
    }
    if (!matched) {
      const id = getTagId('General');
      if (id) insertTag.run(cardId, id);
    }

    // Level (only if not already tagged)
    const hasLevel = db.prepare(`
      SELECT 1 FROM card_tags ct JOIN tags t ON t.id = ct.tag_id
      WHERE ct.card_id = ? AND t.type = 'level'
    `).get(cardId);
    if (!hasLevel) {
      const level = guessLevel(card.chinese, card.english);
      const id = getTagId(level);
      if (id) insertTag.run(cardId, id);
    }
  })();
}

module.exports = { autoTagCard };
