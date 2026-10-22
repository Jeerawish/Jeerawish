import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, fullDeck } from '../js/cards.js';
import { evaluate, describe, categoryOf, bestHand, CATEGORY } from '../js/evaluator.js';

const ev = (s) => evaluate(parseCards(s));
const desc = (s) => describe(ev(s));

test('every category beats the one below it', () => {
  const ladder = [
    '2c 4d 7h 9s Jc', // high card
    '2c 2d 7h 9s Jc', // pair
    '2c 2d 7h 7s Jc', // two pair
    '2c 2d 2h 9s Jc', // trips
    '5c 6d 7h 8s 9c', // straight
    '2h 4h 7h 9h Jh', // flush
    '2c 2d 2h 9s 9c', // full house
    '2c 2d 2h 2s Jc', // quads
    '5h 6h 7h 8h 9h', // straight flush
  ];
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ev(ladder[i]) > ev(ladder[i - 1]), `${ladder[i]} should beat ${ladder[i - 1]}`);
    assert.equal(categoryOf(ev(ladder[i])), i);
  }
});

test('wheel is the lowest straight; six-high beats it', () => {
  assert.equal(desc('Ac 2d 3h 4s 5c'), 'Straight, Five high');
  assert.ok(ev('2d 3h 4s 5c 6c') > ev('Ac 2d 3h 4s 5c'));
  assert.ok(ev('Tc Jd Qh Ks Ac') > ev('9c Td Jh Qs Kc'));
  assert.equal(desc('Ah 2h 3h 4h 5h'), 'Straight Flush, Five high');
  assert.equal(desc('Th Jh Qh Kh Ah'), 'Royal Flush');
});

test('kickers decide ties within a category', () => {
  assert.ok(ev('Ac Ad Kh 9s 3c') > ev('Ac Ad Qh Js Tc'));
  assert.ok(ev('Kc Kd 5h 5s 9c') > ev('Kc Kd 5h 5s 8c'));
  assert.ok(ev('2h 4h 7h 9h Kh') < ev('2h 4h 7h 9h Ah'));
  assert.equal(ev('Ac Ad Kh 9s 3c'), ev('Ah As Kd 9c 3d'));
});

test('seven-card edge cases', () => {
  // Three pairs: best two pairs plus the best remaining kicker (which can come from the third pair).
  assert.equal(desc('Ac Ad 9h 9s 4c 4d 2h'), 'Two Pair, Aces and Nines');
  assert.ok(ev('Ac Ad 9h 9s 4c 4d 2h') > ev('Ac Ad 9h 9s 3c 2d 2h'));
  // Two sets make a full house using the higher set.
  assert.equal(desc('Kc Kd Kh 5s 5c 5d 2h'), 'Full House, Kings full of Fives');
  // Flush and straight that are not a straight flush.
  assert.equal(categoryOf(ev('4h 5h 6c 7h 8d 9h Kh')), CATEGORY.FLUSH);
  // Six-card straight uses the top end.
  assert.equal(desc('4c 5d 6h 7s 8c 9d 2h'), 'Straight, Nine high');
  // Quads with best kicker from the board.
  assert.equal(desc('9c 9d 9h 9s Ac 2d 3h'), 'Four of a Kind, Nines');
  assert.ok(ev('9c 9d 9h 9s Ac 2d 3h') > ev('9c 9d 9h 9s Kc Qd Jh'));
});

test('bestHand picks and orders the five playing cards', () => {
  const r = bestHand(parseCards('Ah Kd 7c 7s 2h 7d Kc'));
  assert.equal(r.description, 'Full House, Sevens full of Kings');
  assert.deepEqual(
    r.cards.map((c) => c >> 2),
    [5, 5, 5, 11, 11],
  );
  const wheel = bestHand(parseCards('Ac 2d 3h 4s 5c Kd Qh'));
  assert.equal(wheel.cards[4] >> 2, 12, 'ace is shown last in a wheel');
});

test('all 2,598,960 five-card hands have the known category frequencies', () => {
  const freq = new Array(9).fill(0);
  const distinct = new Set();
  const deck = fullDeck();
  const hand = [0, 0, 0, 0, 0];
  for (let a = 0; a < 52; a++) {
    hand[0] = deck[a];
    for (let b = a + 1; b < 52; b++) {
      hand[1] = deck[b];
      for (let c = b + 1; c < 52; c++) {
        hand[2] = deck[c];
        for (let d = c + 1; d < 52; d++) {
          hand[3] = deck[d];
          for (let e = d + 1; e < 52; e++) {
            hand[4] = deck[e];
            const s = evaluate(hand);
            freq[s >> 20]++;
            distinct.add(s);
          }
        }
      }
    }
  }
  assert.deepEqual(freq, [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
  assert.equal(distinct.size, 7462, 'number of distinct hand values');
});

test('seven-card evaluation equals the best of its 21 five-card subsets', () => {
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let t = 0; t < 20000; t++) {
    const deck = fullDeck();
    const seven = [];
    for (let i = 0; i < 7; i++) seven.push(deck.splice(rand(deck.length), 1)[0]);
    let best = -1;
    for (let i = 0; i < 7; i++) {
      for (let j = i + 1; j < 7; j++) {
        const five = seven.filter((_, k) => k !== i && k !== j);
        best = Math.max(best, evaluate(five));
      }
    }
    assert.equal(evaluate(seven), best);
  }
});
