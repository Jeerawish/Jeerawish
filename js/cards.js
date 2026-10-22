// Card primitives. A card is an integer 0..51: rank = card >> 2 (0 = deuce .. 12 = ace),
// suit = card & 3 (0 = spades, 1 = hearts, 2 = diamonds, 3 = clubs).

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const RANK_NAMES = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
export const RANK_PLURALS = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
export const SUITS = ['s', 'h', 'd', 'c'];
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
export const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];

export const rankOf = (card) => card >> 2;
export const suitOf = (card) => card & 3;
export const makeCard = (rank, suit) => (rank << 2) | suit;

export function cardToString(card) {
  return RANKS[rankOf(card)] + SUITS[suitOf(card)];
}

export function cardToPretty(card) {
  return RANK_LABELS[rankOf(card)] + SUIT_SYMBOLS[suitOf(card)];
}

export function cardName(card) {
  return `${RANK_NAMES[rankOf(card)]} of ${SUIT_NAMES[suitOf(card)]}`;
}

/** Parses "As", "Td", "10h" into a card integer. */
export function parseCard(text) {
  const t = text.trim();
  const suit = SUITS.indexOf(t.slice(-1).toLowerCase());
  let r = t.slice(0, -1).toUpperCase();
  if (r === '10') r = 'T';
  const rank = RANKS.indexOf(r);
  if (rank < 0 || suit < 0) throw new Error(`Invalid card: ${text}`);
  return makeCard(rank, suit);
}

export function parseCards(text) {
  return text.trim().split(/\s+/).filter(Boolean).map(parseCard);
}

export function fullDeck() {
  return Array.from({ length: 52 }, (_, i) => i);
}

/** Uniform random integer in [0, max) using the Web Crypto API when available. */
export function secureRandomInt(max) {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max; // rejection sampling avoids modulo bias
    let x;
    do {
      c.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  }
  return Math.floor(Math.random() * max);
}

/** Fisher–Yates shuffle (in place). */
export function shuffle(array, randInt = secureRandomInt) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

export class Deck {
  constructor(randInt = secureRandomInt) {
    this.cards = shuffle(fullDeck(), randInt);
  }

  draw() {
    if (!this.cards.length) throw new Error('Deck is empty');
    return this.cards.pop();
  }

  burn() {
    this.cards.pop();
  }

  get remaining() {
    return this.cards.length;
  }
}
