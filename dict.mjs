/**
 * Offline Chinese-English dictionary backed by CC-CEDICT.
 * ESM module — loaded via dynamic import() from server.js.
 */

import cedictPkg from 'cc-cedict';
import { pinyin as getPinyinToned } from 'pinyin-pro';

const { all, simplified: simplifiedIndex } = cedictPkg.data;

// ── Tone-number → tone-mark conversion ────────────────────────────────

const TONE_VOWELS = {
  a: ['ā','á','ǎ','à','a'],
  e: ['ē','é','ě','è','e'],
  i: ['ī','í','ǐ','ì','i'],
  o: ['ō','ó','ǒ','ò','o'],
  u: ['ū','ú','ǔ','ù','u'],
  v: ['ǖ','ǘ','ǚ','ǜ','ü'],
  ü: ['ǖ','ǘ','ǚ','ǜ','ü'],
};

function applyToneMark(syl, toneNum) {
  const t = parseInt(toneNum) - 1; // 0-indexed
  if (t < 0 || t > 4) return syl;
  if (t === 4) return syl; // neutral tone — no mark

  // Rule 1: a or e always takes the mark
  for (let i = 0; i < syl.length; i++) {
    if (syl[i] === 'a' || syl[i] === 'e') {
      const marks = TONE_VOWELS[syl[i]];
      return syl.slice(0, i) + marks[t] + syl.slice(i + 1);
    }
  }

  // Rule 2: "ou" → mark the o
  const ouPos = syl.indexOf('ou');
  if (ouPos !== -1) {
    return syl.slice(0, ouPos) + TONE_VOWELS['o'][t] + syl.slice(ouPos + 1);
  }

  // Rule 3: last vowel (covers ui→i, iu→u, etc.)
  for (let i = syl.length - 1; i >= 0; i--) {
    const c = syl[i];
    if (TONE_VOWELS[c]) {
      return syl.slice(0, i) + TONE_VOWELS[c][t] + syl.slice(i + 1);
    }
  }

  return syl;
}

export function numberedToToned(numbered) {
  return (numbered || '')
    .split(' ')
    .map(syl => {
      const num = syl.slice(-1);
      if (!'12345'.includes(num)) return syl;
      const base = syl.slice(0, -1).replace(/v/g, 'ü');
      return applyToneMark(base, num);
    })
    .join(' ');
}

// ── Definition helpers ─────────────────────────────────────────────────

function cleanDef(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\(CL:[^)]*\)/g, '')
    .replace(/\([^)]{0,60}\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isSkipEntry(def_raw) {
  const first = Array.isArray(def_raw) ? def_raw[0] : def_raw;
  if (typeof first !== 'string') return true;
  return first.startsWith('variant of') || first.startsWith('see ') || first.startsWith('abbr. for');
}

function getPrimaryDef(def_raw) {
  const defs = Array.isArray(def_raw) ? def_raw : [def_raw];
  for (const d of defs) {
    if (typeof d !== 'string') continue;
    if (d.startsWith('variant of') || d.startsWith('see ') || d.startsWith('abbr.')) continue;
    const c = cleanDef(d);
    if (c) return c;
  }
  return '';
}

function buildEnglish(def_raw) {
  const defs = Array.isArray(def_raw) ? def_raw : [def_raw];
  return defs
    .filter(d => typeof d === 'string' && !d.startsWith('variant of') && !d.startsWith('see '))
    .map(cleanDef)
    .filter(Boolean)
    .slice(0, 4)
    .join('; ');
}

// ── Chinese → entry lookup (via simplifiedIndex for best reading) ──────

function getBestEntry(chineseText) {
  const readings = simplifiedIndex[chineseText];
  if (!readings) return null;

  // Sort pinyin keys: prefer lowercase (common word over surname)
  const pinyinKeys = Object.keys(readings).sort((a, b) => {
    const aLow = a[0] === a[0].toLowerCase() ? 0 : 1;
    const bLow = b[0] === b[0].toLowerCase() ? 0 : 1;
    return aLow - bLow;
  });

  for (const py of pinyinKeys) {
    const idxObj = readings[py][0];
    const idx = idxObj['0'];
    if (idx === undefined) continue;
    const entry = all[idx];
    if (!entry || isSkipEntry(entry[3])) continue;
    return entry;
  }
  return null;
}

// ── English → Chinese reverse index ───────────────────────────────────
//
// Score system (lower = better match):
//   0 — primary def exactly equals query
//   1 — primary def starts with query (query is first part of compound def like "water; river")
//   2 — primary def first word equals query
//   3 — any definition contains query as a whole segment
//
// Among equal score: filter non-CJK (slang like 3Q), then prefer shorter.

const CJK_RE = /^[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}]+$/u;

function entryWeight(entry) {
  const simp = entry[1];
  if (!CJK_RE.test(simp)) return 1000; // non-CJK strings (3Q, etc.) deprioritized
  return simp.length;
}

// Curated overrides for common beginner vocab where CC-CEDICT lookup is ambiguous.
// Keyed by lowercase English → simplified Chinese.
const COMMON_OVERRIDES = {
  'hello': '你好', 'hi': '你好',
  'thank you': '谢谢', 'thanks': '谢谢',
  'goodbye': '再见', 'bye': '再见', 'bye bye': '再见',
  'good morning': '早上好', 'good afternoon': '下午好',
  'good evening': '晚上好', 'good night': '晚安',
  'please': '请', 'yes': '是', 'no': '不', 'ok': '好',
  'sorry': '对不起', 'excuse me': '不好意思',
  'how are you': '你好吗', 'i love you': '我爱你',
  'dog': '狗', 'cat': '猫', 'fish': '鱼', 'bird': '鸟',
  'book': '书', 'teacher': '老师', 'student': '学生',
  'friend': '朋友', 'mother': '妈妈', 'father': '爸爸',
  'mom': '妈妈', 'dad': '爸爸', 'child': '孩子',
  'love': '爱', 'eat': '吃', 'to eat': '吃',
  'drink': '喝', 'to drink': '喝',
  'go': '去', 'come': '来', 'see': '看', 'want': '想',
  'speak': '说', 'listen': '听', 'read': '读', 'write': '写',
  'study': '学习', 'work': '工作', 'sleep': '睡觉',
  'food': '食物', 'water': '水', 'rice': '米饭',
  'house': '房子', 'person': '人', 'man': '男人', 'woman': '女人',
  'good': '好', 'bad': '坏', 'big': '大', 'small': '小',
  'new': '新', 'old': '旧', 'happy': '快乐', 'sad': '难过',
  'beautiful': '美丽', 'money': '钱', 'time': '时间', 'day': '天',
  'today': '今天', 'tomorrow': '明天', 'yesterday': '昨天',
  'china': '中国', 'chinese': '中文', 'english': '英语',
};

function scoreEntry(entry, query) {
  const [, simp, , def_raw] = entry;
  const defs = Array.isArray(def_raw) ? def_raw : [def_raw];
  let best = 99;

  for (let di = 0; di < defs.length; di++) {
    const d = defs[di];
    if (typeof d !== 'string') continue;
    if (d.startsWith('variant of') || d.startsWith('see ')) continue;

    const cleaned = cleanDef(d).toLowerCase();
    if (!cleaned) continue;

    const isPrimary = di === 0;
    const parts = cleaned.split(/;\s*/);

    for (const part of parts) {
      if (part === query) {
        const score = isPrimary ? 0 : 3;
        if (score < best) best = score;
      } else if (isPrimary && part.split(/[\s,]+/)[0] === query) {
        if (1 < best) best = 1;
      } else if (isPrimary && part.startsWith(query + ' ')) {
        if (2 < best) best = 2;
      }
    }
  }

  return best;
}

// Build candidates: for each unique simplified entry, score against its definitions
// We index: exact phrase → scored candidates list
const englishIndex = new Map(); // query_str → [{score, entry}]

for (const entry of all) {
  const [, simp, , def_raw] = entry;
  if (!simp || isSkipEntry(def_raw)) continue;

  const defs = Array.isArray(def_raw) ? def_raw : [def_raw];

  const phrases = new Set();
  for (const d of defs) {
    if (typeof d !== 'string') continue;
    if (d.startsWith('variant of') || d.startsWith('see ')) continue;
    const cleaned = cleanDef(d).toLowerCase();
    if (!cleaned || cleaned.length >= 50) continue;
    // Add full cleaned def, each semicolon segment, and first word
    phrases.add(cleaned);
    for (const p of cleaned.split(/;\s*/)) {
      if (p) phrases.add(p.trim());
    }
    const firstWord = cleaned.split(/[\s,;]+/)[0];
    if (firstWord && firstWord.length > 1) phrases.add(firstWord);
  }

  for (const phrase of phrases) {
    if (!phrase || phrase.length < 2) continue;
    if (!englishIndex.has(phrase)) englishIndex.set(phrase, []);
    englishIndex.get(phrase).push(entry);
  }
}

// For each indexed phrase, sort candidates: score first, then entry weight
for (const [phrase, candidates] of englishIndex) {
  candidates.sort((a, b) => {
    const sa = scoreEntry(a, phrase);
    const sb = scoreEntry(b, phrase);
    if (sa !== sb) return sa - sb;
    return entryWeight(a) - entryWeight(b);
  });
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Look up a Chinese word/phrase.
 * Always returns { chinese, pinyin, english }.
 */
export function lookupChinese(text) {
  const pinyinToned = getPinyinToned(text, {
    toneType: 'symbol', separator: ' ', nonZh: 'consecutive',
  });
  const entry = getBestEntry(text);
  if (!entry) return { chinese: text, pinyin: pinyinToned, english: '' };
  return { chinese: text, pinyin: pinyinToned, english: buildEnglish(entry[3]) };
}

/**
 * Look up an English word/phrase → best Chinese match.
 * Returns { chinese, pinyin, english } or null.
 */
export function lookupEnglish(text) {
  const query = text.trim().toLowerCase();

  // Check curated overrides first
  const overrideChinese = COMMON_OVERRIDES[query]
    ?? COMMON_OVERRIDES[query.replace(/^to /, '')]
    ?? COMMON_OVERRIDES[query.replace(/^(a|an|the) /, '')];

  if (overrideChinese) {
    return lookupChinese(overrideChinese);
  }

  const variants = [
    query,
    query.replace(/^to /, ''),
    query.replace(/^(a|an|the) /, ''),
  ];

  let bestEntry = null;
  let bestScore = 99;

  for (const v of variants) {
    const candidates = englishIndex.get(v);
    if (!candidates?.length) continue;
    const score = scoreEntry(candidates[0], v);
    if (score < bestScore) {
      bestScore = score;
      bestEntry = candidates[0];
    }
  }

  if (!bestEntry) return null;

  const [, simp, pinyinNum, def_raw] = bestEntry;
  return {
    chinese: simp,
    pinyin: numberedToToned(pinyinNum),
    english: buildEnglish(def_raw) || text,
  };
}

export const ready = true;
