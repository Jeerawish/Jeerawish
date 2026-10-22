// Fast poker hand evaluator for 5–7 cards.
//
// evaluate() returns an integer score where a higher score is a better hand:
//   score = category << 20 | k1 << 16 | k2 << 12 | k3 << 8 | k4 << 4 | k5
// where category is 0 (high card) .. 8 (straight flush) and k1..k5 are tiebreak ranks.

import { rankOf, suitOf, RANK_NAMES, RANK_PLURALS } from './cards.js';

export const CATEGORY = Object.freeze({
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
});

export const CATEGORY_NAMES = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
];

const WHEEL_MASK = 0x100f; // A, 5, 4, 3, 2

// Scratch buffers reused across calls; evaluate() is hot in AI simulations.
const counts = new Uint8Array(13);
const suitCounts = new Uint8Array(4);
const suitMasks = new Uint16Array(4);

function pack(category, a = 0, b = 0, c = 0, d = 0, e = 0) {
  return (category << 20) | (a << 16) | (b << 12) | (c << 8) | (d << 4) | e;
}

/** Highest rank of a 5-card straight contained in a 13-bit rank mask, or -1. */
export function straightHigh(mask) {
  for (let hi = 12; hi >= 4; hi--) {
    if (((mask >> (hi - 4)) & 0x1f) === 0x1f) return hi;
  }
  if ((mask & WHEEL_MASK) === WHEEL_MASK) return 3;
  return -1;
}

/** Top `n` ranks set in mask, descending. */
function topRanks(mask, n) {
  const out = [];
  for (let r = 12; r >= 0 && out.length < n; r--) {
    if (mask & (1 << r)) out.push(r);
  }
  return out;
}

export function evaluate(cards) {
  counts.fill(0);
  suitCounts.fill(0);
  suitMasks.fill(0);
  let rankMask = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const r = c >> 2;
    const s = c & 3;
    counts[r]++;
    suitCounts[s]++;
    suitMasks[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  // With at most 7 cards a flush excludes quads and full houses, so it can be checked first.
  for (let s = 0; s < 4; s++) {
    if (suitCounts[s] >= 5) {
      const sf = straightHigh(suitMasks[s]);
      if (sf >= 0) return pack(CATEGORY.STRAIGHT_FLUSH, sf);
      const t = topRanks(suitMasks[s], 5);
      return pack(CATEGORY.FLUSH, t[0], t[1], t[2], t[3], t[4]);
    }
  }

  let quad = -1;
  let trip1 = -1;
  let trip2 = -1;
  let pair1 = -1;
  let pair2 = -1;
  let pair3 = -1;
  for (let r = 12; r >= 0; r--) {
    const n = counts[r];
    if (n === 4) quad = r;
    else if (n === 3) {
      if (trip1 < 0) trip1 = r;
      else if (trip2 < 0) trip2 = r;
    } else if (n === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
      else if (pair3 < 0) pair3 = r;
    }
  }

  if (quad >= 0) {
    const k = topRanks(rankMask & ~(1 << quad), 1);
    return pack(CATEGORY.QUADS, quad, k[0] ?? 0);
  }

  if (trip1 >= 0 && (trip2 >= 0 || pair1 >= 0)) {
    return pack(CATEGORY.FULL_HOUSE, trip1, Math.max(trip2, pair1));
  }

  const st = straightHigh(rankMask);
  if (st >= 0) return pack(CATEGORY.STRAIGHT, st);

  if (trip1 >= 0) {
    const k = topRanks(rankMask & ~(1 << trip1), 2);
    return pack(CATEGORY.TRIPS, trip1, k[0] ?? 0, k[1] ?? 0);
  }

  if (pair2 >= 0) {
    const k = topRanks(rankMask & ~(1 << pair1) & ~(1 << pair2), 1);
    return pack(CATEGORY.TWO_PAIR, pair1, pair2, k[0] ?? 0);
  }

  if (pair1 >= 0) {
    const k = topRanks(rankMask & ~(1 << pair1), 3);
    return pack(CATEGORY.PAIR, pair1, k[0] ?? 0, k[1] ?? 0, k[2] ?? 0);
  }

  const t = topRanks(rankMask, 5);
  return pack(CATEGORY.HIGH_CARD, t[0] ?? 0, t[1] ?? 0, t[2] ?? 0, t[3] ?? 0, t[4] ?? 0);
}

export const categoryOf = (score) => score >> 20;

function kicker(score, i) {
  return (score >> (16 - 4 * i)) & 0xf;
}

/** Human-readable description of a score, e.g. "Full House, Kings full of Fives". */
export function describe(score) {
  const cat = categoryOf(score);
  const k = (i) => kicker(score, i);
  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH:
      return k(0) === 12 ? 'Royal Flush' : `Straight Flush, ${RANK_NAMES[k(0)]} high`;
    case CATEGORY.QUADS:
      return `Four of a Kind, ${RANK_PLURALS[k(0)]}`;
    case CATEGORY.FULL_HOUSE:
      return `Full House, ${RANK_PLURALS[k(0)]} full of ${RANK_PLURALS[k(1)]}`;
    case CATEGORY.FLUSH:
      return `Flush, ${RANK_NAMES[k(0)]} high`;
    case CATEGORY.STRAIGHT:
      return `Straight, ${RANK_NAMES[k(0)]} high`;
    case CATEGORY.TRIPS:
      return `Three of a Kind, ${RANK_PLURALS[k(0)]}`;
    case CATEGORY.TWO_PAIR:
      return `Two Pair, ${RANK_PLURALS[k(0)]} and ${RANK_PLURALS[k(1)]}`;
    case CATEGORY.PAIR:
      return `Pair of ${RANK_PLURALS[k(0)]}`;
    default:
      return `High Card, ${RANK_NAMES[k(0)]}`;
  }
}

/** Short name, e.g. "Two Pair" or "Royal Flush". */
export function shortName(score) {
  const cat = categoryOf(score);
  if (cat === CATEGORY.STRAIGHT_FLUSH && kicker(score, 0) === 12) return 'Royal Flush';
  return CATEGORY_NAMES[cat];
}

function* combinations(arr, k, start = 0, picked = []) {
  if (picked.length === k) {
    yield picked.slice();
    return;
  }
  for (let i = start; i <= arr.length - (k - picked.length); i++) {
    picked.push(arr[i]);
    yield* combinations(arr, k, i + 1, picked);
    picked.pop();
  }
}

/**
 * Finds the best five-card hand among 5–7 cards. Used for UI (highlighting the cards
 * that make the hand), so clarity beats raw speed here.
 */
export function bestHand(cards) {
  if (cards.length < 5) {
    return { score: -1, cards: [], name: '', description: '' };
  }
  let best = -1;
  let bestCards = null;
  for (const combo of combinations(cards, 5)) {
    const s = evaluate(combo);
    if (s > best) {
      best = s;
      bestCards = combo;
    }
  }
  return { score: best, cards: sortForDisplay(bestCards, best), name: shortName(best), description: describe(best) };
}

/** Orders the five cards of a made hand the way a player would read them (grouped, high first). */
function sortForDisplay(cards, score) {
  const cat = categoryOf(score);
  const freq = new Map();
  for (const c of cards) freq.set(rankOf(c), (freq.get(rankOf(c)) || 0) + 1);
  const sorted = cards.slice().sort((a, b) => {
    const fa = freq.get(rankOf(a));
    const fb = freq.get(rankOf(b));
    if (fa !== fb) return fb - fa;
    if (rankOf(a) !== rankOf(b)) return rankOf(b) - rankOf(a);
    return suitOf(a) - suitOf(b);
  });
  // A wheel (5-4-3-2-A) reads with the ace last.
  if ((cat === CATEGORY.STRAIGHT || cat === CATEGORY.STRAIGHT_FLUSH) && kicker(score, 0) === 3) {
    const ace = sorted.findIndex((c) => rankOf(c) === 12);
    if (ace >= 0) sorted.push(sorted.splice(ace, 1)[0]);
  }
  return sorted;
}

/**
 * Describes what a player holds before the board is complete; with fewer than five cards
 * only pairs/high card are possible.
 */
export function describePartial(cards) {
  if (cards.length >= 5) return bestHand(cards).description;
  if (cards.length === 0) return '';
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  if (cards.length >= 2 && ranks[0] === ranks[1]) return `Pair of ${RANK_PLURALS[ranks[0]]}`;
  return `${RANK_NAMES[ranks[0]]} high`;
}
