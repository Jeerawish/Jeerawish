import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards } from '../js/cards.js';
import { PokerGame } from '../js/engine.js';
import { decide, estimateEquity, equityVsKnown, preflopPercentile, BOT_ROSTER } from '../js/ai.js';

const WIDE = { range: 1, postAggr: 0 };

test('equity estimates match known heads-up values', () => {
  const eq = (hand) => estimateEquity(parseCards(hand), [], [WIDE], 30000);
  assert.ok(Math.abs(eq('As Ad') - 0.852) < 0.015, 'AA ≈ 85%');
  assert.ok(Math.abs(eq('7c 2d') - 0.346) < 0.015, '72o ≈ 35%');
  // A made flush on the river cannot lose to a random hand very often.
  const flush = estimateEquity(parseCards('Ah 5h'), parseCards('Kh 9h 2h 7c 3d'), [WIDE], 5000);
  assert.ok(flush > 0.95);
});

test('preflop chart ranks premium hands above trash', () => {
  const pct = (h) => preflopPercentile(...parseCards(h));
  assert.ok(pct('As Ad') < 0.01);
  assert.ok(pct('As Ad') < pct('Ks Kd'));
  assert.ok(pct('As Ks') < pct('As Kd'));
  assert.ok(pct('7c 2d') > 0.95);
});

test('bots only make legal decisions and finish tournaments at every difficulty', async () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    for (let n = 2; n <= 6; n += 2) {
      const players = BOT_ROSTER.slice(0, n).map((b) => ({ ...b, chips: 1000 }));
      const g = new PokerGame({
        players,
        handsPerLevel: 4,
        // applyAction throws on anything illegal, failing the test.
        getAction: async (p, legal, game) => {
          const a = decide(p, legal, game, difficulty);
          if (legal.canCheck) assert.notEqual(a.type, 'fold', 'never folds when checking is free');
          return a;
        },
      });
      let hands = 0;
      while (!g.isOver && hands < 400) {
        await g.playHand();
        hands++;
      }
      assert.ok(g.isOver, `${difficulty} ${n}-handed game finished in ${hands} hands`);
      assert.equal(g.players.reduce((s, p) => s + p.chips, 0), n * 1000);
    }
  }
});

test('equity against face-up hands', () => {
  // AA vs KK all-in pre-flop is about 82%.
  const aa = equityVsKnown(parseCards('As Ad'), [parseCards('Kc Kd')], [], 20000);
  assert.ok(Math.abs(aa - 0.82) < 0.015, `AA vs KK ≈ 82% (got ${aa})`);
  // On the river the result is exact.
  assert.equal(equityVsKnown(parseCards('As Ad'), [parseCards('Kc Kd')], parseCards('2h 7c 9d Jh 3s')), 1);
  assert.equal(equityVsKnown(parseCards('As Kd'), [parseCards('Ac Kh')], parseCards('2h 7c 9d Jh 3s')), 0.5);
});
