import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, fullDeck } from '../js/cards.js';
import { PokerGame } from '../js/engine.js';

/**
 * Builds a deck that deals the given hole cards (in deal order, starting left of the button)
 * followed by the board, with burn cards taken from the unused remainder.
 */
function stackedDeck(holes, board = '') {
  const holeCards = holes.map(parseCards);
  const boardCards = parseCards(board);
  const used = new Set([...holeCards.flat(), ...boardCards]);
  const spare = fullDeck().filter((c) => !used.has(c));
  const seq = [];
  for (let r = 0; r < 2; r++) for (const h of holeCards) seq.push(h[r]);
  const take = () => (boardCards.length ? boardCards.shift() : spare.pop());
  seq.push(spare.pop(), take(), take(), take(), spare.pop(), take(), spare.pop(), take());
  return () => ({ draw: () => seq.shift(), burn: () => seq.shift() });
}

/** Scripted decisions: each entry is [playerName, action] consumed in order. */
function scripted(script) {
  const queue = script.slice();
  return async (p, legal) => {
    if (!queue.length) {
      return legal.canCheck ? { type: 'check' } : { type: 'call' };
    }
    const [name, action] = queue.shift();
    assert.equal(p.name, name, `expected ${name} to act, got ${p.name}`);
    return action;
  };
}

function makeGame(stacks, opts = {}) {
  const players = stacks.map((chips, i) => ({ name: String.fromCharCode(65 + i), chips }));
  return new PokerGame({ players, ...opts });
}

const total = (g) => g.players.reduce((s, p) => s + p.chips, 0);

test('heads-up: button posts small blind and acts first preflop, last postflop', async () => {
  const order = [];
  const g = makeGame([1000, 1000], {
    getAction: async (p, legal) => {
      order.push(`${g.street}:${p.name}`);
      return legal.canCheck ? { type: 'check' } : { type: 'call' };
    },
  });
  await g.playHand();
  // Hand 1: button is A (index 0).
  assert.equal(g.dealerIndex, 0);
  assert.equal(g.sbIndex, 0);
  assert.deepEqual(order, [
    'preflop:A', 'preflop:B',
    'flop:B', 'flop:A',
    'turn:B', 'turn:A',
    'river:B', 'river:A',
  ]);
  assert.equal(total(g), 2000);
});

test('blinds post and folding to the big blind refunds the uncalled amount', async () => {
  const g = makeGame([1000, 1000, 1000], {
    getAction: scripted([['A', { type: 'fold' }], ['B', { type: 'fold' }]]),
  });
  await g.playHand();
  // Button A, SB B (10), BB C (20). C wins B's 10.
  assert.deepEqual(g.players.map((p) => p.chips), [1000, 990, 1010]);
});

test('minimum raise is the size of the last full raise', async () => {
  const seen = [];
  const g = makeGame([1000, 1000, 1000], {
    getAction: async (p, legal) => {
      seen.push([p.name, legal.minRaiseTo]);
      if (p.name === 'A' && seen.length === 1) return { type: 'raise', amount: 70 }; // raise of 50
      if (p.name === 'B' && seen.length === 2) return { type: 'raise', amount: 200 }; // raise of 130
      return { type: 'fold' };
    },
  });
  await g.playHand();
  assert.deepEqual(seen[0], ['A', 40]);
  assert.deepEqual(seen[1], ['B', 120]);
  assert.deepEqual(seen[2], ['C', 330]);
});

test('an incomplete all-in raise does not reopen betting for players who already acted', async () => {
  const legals = [];
  const g = makeGame([1000, 130, 1000], {
    getAction: async (p, legal) => {
      legals.push([p.name, legal.canRaise]);
      if (legals.length === 1) return { type: 'raise', amount: 100 }; // A raises to 100
      if (legals.length === 2) return { type: 'allin' }; // B all-in to 130 (incomplete raise)
      if (legals.length === 3) return { type: 'call' }; // C has not acted on a full raise: may raise
      return { type: 'call' };
    },
  });
  await g.playHand();
  assert.deepEqual(legals.slice(0, 4), [
    ['A', true],
    ['B', true],
    ['C', true],
    ['A', false], // A faces only a 30-chip incomplete raise
  ]);
});

test('incomplete raises that add up to a full raise reopen the betting', async () => {
  // A (button), B (SB), C (BB), D (first to act). D raises to 100 (a raise of 80), then A and B
  // go all-in for small, incomplete raises. D may re-raise only if together they reach +80.
  const play = async (bStack) => {
    const legals = [];
    const g = makeGame([150, bStack, 1000, 1000], {
      getAction: async (p, legal) => {
        legals.push([p.name, legal.canRaise, legal.minRaiseTo]);
        if (legals.length === 1) return { type: 'raise', amount: 100 };
        if (legals.length <= 3) return { type: 'allin' }; // A to 150, B to bStack
        if (legals.length === 4) return { type: 'call' }; // C
        return { type: 'fold' };
      },
    });
    await g.playHand();
    return legals;
  };

  const reopened = await play(200); // 100 → 150 → 200: +100 total
  assert.deepEqual(reopened[0], ['D', true, 40]);
  assert.deepEqual(reopened[1], ['A', true, 150]);
  assert.deepEqual(reopened[2], ['B', true, 200]);
  assert.deepEqual(reopened[4], ['D', true, 280]);

  const closed = await play(170); // 100 → 150 → 170: only +70
  assert.equal(closed[4][0], 'D');
  assert.equal(closed[4][1], false);
});

test('side pots are built from all-in levels and awarded separately', async () => {
  // A (button) 500, B (SB) 100, C (BB) 300. Everyone all-in preflop.
  // B has the best hand, C second, A worst.
  const g = makeGame([500, 100, 300], {
    deckFactory: stackedDeck(['As Ad', 'Kc Kd', '2c 7d'], '3h 8s 9c Jd 4h'),
    getAction: async () => ({ type: 'allin' }),
  });
  // Deal order starts at SB (B): B gets As Ad, C gets Kc Kd, A gets 2c 7d.
  const summary = await g.playHand();
  const pots = summary.result.pots.map((p) => [p.amount, p.winners]);
  assert.deepEqual(pots, [
    [300, ['p1']], // main pot: 100 x 3
    [400, ['p2']], // side pot: 200 x 2
  ]);
  // A's uncalled 200 is returned.
  assert.deepEqual(g.players.map((p) => p.chips), [200, 300, 400]);
  assert.equal(total(g), 900);
  assert.equal(g.players[0].eliminated, false);
  assert.equal(g.players[1].eliminated, false);
});

test('split pots are shared equally between tied hands', async () => {
  // Royal flush on board: everyone who reaches showdown chops.
  const g = makeGame([1000, 1005, 1000], {
    deckFactory: stackedDeck(['2c 3d', '2d 3c', '4s 5s'], 'Ah Kh Qh Jh Th'),
    getAction: scripted([
      ['A', { type: 'call' }],
      ['B', { type: 'raise', amount: 75 }],
      ['C', { type: 'call' }],
      ['A', { type: 'fold' }],
    ]),
  });
  await g.playHand();
  // Pot = 20 (A) + 75 + 75 = 170, split 85/85 between B and C.
  assert.deepEqual(g.players.map((p) => p.chips), [980, 1015, 1010]);
});

test('odd chip goes to the first winner clockwise of the button', async () => {
  const g = makeGame([1000, 1000, 1000], {
    blindLevels: [[15, 30]],
    deckFactory: stackedDeck(['2c 3d', '9d 3c', '4s 5s'], 'Ah Kh Qh Jh Th'),
    getAction: scripted([
      ['A', { type: 'call' }],
      ['B', { type: 'fold' }],
      ['C', { type: 'check' }],
    ]),
  });
  await g.playHand();
  // Pot = 30 + 15 + 30 = 75 → 38 to C (first winner left of button A), 37 to A.
  assert.deepEqual(g.players.map((p) => p.chips), [1007, 985, 1008]);
});

test('short big blind still requires the full blind to call; excess is refunded', async () => {
  const g = makeGame([1000, 1000, 12], {
    deckFactory: stackedDeck(['2c 3d', 'As Ad', '9d 3c'], 'Kh 7c 4d 9s 2h'),
    getAction: scripted([
      ['A', { type: 'fold' }],
      ['B', { type: 'call' }],
    ]),
  });
  const summary = await g.playHand();
  // B calls 20 total; only 12 is matched by C; 8 is uncalled and returned. Pot 24 to C.
  assert.equal(summary.result.payouts.p2, 24);
  assert.deepEqual(g.players.map((p) => p.chips), [1000, 988, 24]);
});

test('busted players are eliminated with finishing places; button skips them', async () => {
  const g = makeGame([1000, 50, 1000], {
    deckFactory: stackedDeck(['2c 7d', 'As Ad', 'Kc Kd'], 'Kh 8s 9c Jd 4h'),
    getAction: scripted([
      ['A', { type: 'fold' }],
      ['B', { type: 'allin' }],
      ['C', { type: 'call' }],
    ]),
  });
  const summary = await g.playHand();
  assert.equal(g.players[1].eliminated, true);
  assert.equal(g.players[1].place, 3);
  assert.equal(summary.busted.length, 1);
  assert.equal(g.upcomingDealer(), 2);
});

test('blinds increase on schedule', async () => {
  const g = makeGame([1000, 1000], {
    handsPerLevel: 2,
    getAction: async (p, legal) => (legal.canCheck ? { type: 'check' } : { type: 'fold' }),
  });
  const levels = [];
  for (let i = 0; i < 5; i++) {
    await g.playHand();
    levels.push(g.bigBlind);
  }
  assert.deepEqual(levels, [20, 20, 30, 30, 40]);
});

test('fuzz: random legal play conserves chips and always terminates', async () => {
  let seed = 99;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let gi = 0; gi < 60; gi++) {
    const n = 2 + (gi % 5);
    const stack = 500 + 100 * (gi % 4);
    const chipsInPlay = n * stack;
    const g = makeGame(Array(n).fill(stack), {
      handsPerLevel: 5,
      getAction: async (p, legal) => {
        const r = rand();
        if (legal.canRaise && r < 0.25) {
          const to = legal.minRaiseTo + Math.floor(rand() * (legal.maxRaiseTo - legal.minRaiseTo + 1));
          return { type: 'raise', amount: to };
        }
        if (r < 0.35 && !legal.canCheck) return { type: 'fold' };
        if (r < 0.4) return { type: 'allin' };
        return legal.canCheck ? { type: 'check' } : { type: 'call' };
      },
      emit: async (type, payload, game) => {
        if (type === 'action' || type === 'collect') {
          for (const p of game.players) assert.ok(p.chips >= 0, 'no negative stacks');
          assert.equal(total(game) + game.totalPot, chipsInPlay, 'chips in stacks + pot are constant');
        }
      },
    });
    let hands = 0;
    while (!g.isOver && hands < 500) {
      await g.playHand();
      hands++;
      assert.equal(total(g), chipsInPlay, `chips conserved (game ${gi}, hand ${hands})`);
    }
    assert.ok(g.isOver, `game ${gi} finished`);
    const places = g.players.map((p) => p.place).sort((a, b) => a - b);
    assert.deepEqual(places, Array.from({ length: n }, (_, i) => i + 1));
  }
});

test('legal actions expose call amounts capped at the stack', async () => {
  let captured;
  const g = makeGame([1000, 1000, 1000], {
    getAction: async (p, legal) => {
      if (p.name === 'A' && !captured) return { type: 'raise', amount: 900 };
      if (p.name === 'B' && !captured) {
        captured = legal;
        return { type: 'fold' };
      }
      return { type: 'fold' };
    },
  });
  await g.playHand();
  assert.equal(captured.toCall, 890);
  assert.equal(captured.canRaise, true);
  // A full raise (to 1,780) is more than B has, so the minimum is B's all-in.
  assert.equal(captured.minRaiseTo, 1000);
  assert.equal(captured.maxRaiseTo, 1000);
});
