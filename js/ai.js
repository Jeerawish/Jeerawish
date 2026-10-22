// Computer opponents. Decisions combine a preflop hand chart (Chen formula percentiles),
// Monte Carlo equity against modeled opponent ranges, pot odds and per-bot personalities.

import { evaluate, categoryOf, CATEGORY } from './evaluator.js';
import { rankOf, suitOf } from './cards.js';

export const STYLES = {
  rock: { label: 'Rock', blurb: 'Tight & cautious', tight: 0.85, aggr: 0.35, bluff: 0.03, sticky: 0 },
  shark: { label: 'Shark', blurb: 'Tight & aggressive', tight: 0.62, aggr: 0.78, bluff: 0.12, sticky: 0 },
  maniac: { label: 'Maniac', blurb: 'Loose & wild', tight: 0.12, aggr: 0.92, bluff: 0.32, sticky: 0.02 },
  station: { label: 'Station', blurb: 'Loves to call', tight: 0.2, aggr: 0.15, bluff: 0.04, sticky: 0.1 },
  pro: { label: 'Pro', blurb: 'Balanced', tight: 0.52, aggr: 0.62, bluff: 0.14, sticky: 0 },
};

export const DIFFICULTY = {
  easy: { iterations: 220, noise: 0.22, modelRanges: false, mistakes: 0.12 },
  normal: { iterations: 450, noise: 0.1, modelRanges: true, mistakes: 0.04 },
  hard: { iterations: 900, noise: 0.04, modelRanges: true, mistakes: 0 },
};

export const BOT_ROSTER = [
  { name: 'Ava', avatar: '🦊', style: 'shark' },
  { name: 'Bruno', avatar: '🐻', style: 'rock' },
  { name: 'Mei', avatar: '🐼', style: 'pro' },
  { name: 'Diego', avatar: '🦁', style: 'maniac' },
  { name: 'Elena', avatar: '🐯', style: 'pro' },
  { name: 'Frank', avatar: '🐸', style: 'station' },
  { name: 'Grace', avatar: '🦉', style: 'shark' },
  { name: 'Hugo', avatar: '🐵', style: 'maniac' },
  { name: 'Iris', avatar: '🐨', style: 'rock' },
  { name: 'Jack', avatar: '🐺', style: 'pro' },
  { name: 'Kira', avatar: '🐱', style: 'station' },
  { name: 'Leo', avatar: '🐲', style: 'shark' },
];

// ------------------------------------------------------------ preflop chart

const HIGH_CARD_POINTS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10];

function chen(hi, lo, suited) {
  if (hi === lo) return Math.max(5, HIGH_CARD_POINTS[hi] * 2);
  let s = HIGH_CARD_POINTS[hi] + (suited ? 2 : 0);
  const gap = hi - lo - 1;
  s -= [0, 1, 2, 4][gap] ?? 5;
  if (gap <= 1 && hi < 10) s += 1;
  return s;
}

const classIndex = (hi, lo, suited) => (hi * 13 + lo) * 2 + (suited ? 1 : 0);
const PERCENTILE = new Float32Array(13 * 13 * 2);

(function buildChart() {
  const classes = [];
  for (let hi = 0; hi < 13; hi++) {
    for (let lo = 0; lo <= hi; lo++) {
      if (hi === lo) classes.push({ hi, lo, suited: false, combos: 6 });
      else {
        classes.push({ hi, lo, suited: true, combos: 4 });
        classes.push({ hi, lo, suited: false, combos: 12 });
      }
    }
  }
  for (const c of classes) c.score = chen(c.hi, c.lo, c.suited);
  classes.sort((a, b) => b.score - a.score || b.hi - a.hi || b.lo - a.lo || b.suited - a.suited);
  let cumulative = 0;
  for (const c of classes) {
    PERCENTILE[classIndex(c.hi, c.lo, c.suited)] = (cumulative + c.combos / 2) / 1326;
    cumulative += c.combos;
  }
})();

/** Where a starting hand ranks among all 1,326 combos: 0 = best (AA), 1 = worst. */
export function preflopPercentile(c1, c2) {
  const r1 = rankOf(c1);
  const r2 = rankOf(c2);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  return PERCENTILE[classIndex(hi, lo, r1 !== r2 && suitOf(c1) === suitOf(c2))];
}

// ------------------------------------------------------------ equity simulation

const WIDE = { range: 1, postAggr: 0 };

/**
 * Monte Carlo equity of `hole` against opponents whose holdings are drawn from `models`
 * ({ range: top fraction of hands they play, postAggr: bets/raises after the flop }).
 */
export function estimateEquity(hole, board, models, iterations = 500, rand = Math.random) {
  const nOpp = models.length;
  if (nOpp === 0) return 1;
  const known = new Set([...hole, ...board]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);

  const need = 5 - board.length;
  const hero = [hole[0], hole[1], ...board, 0, 0, 0, 0, 0].slice(0, 7);
  const opp = new Array(7);
  const holes = new Array(nOpp * 2);
  const partial = new Array(2 + board.length);
  for (let i = 0; i < board.length; i++) {
    opp[2 + i] = board[i];
    partial[2 + i] = board[i];
  }

  const accepts = (a, b, m) => {
    if (m.range < 1 && preflopPercentile(a, b) > m.range) return false;
    if (m.postAggr > 0 && board.length >= 3) {
      partial[0] = a;
      partial[1] = b;
      const cat = categoryOf(evaluate(partial));
      // Aggression after the flop usually means a made hand; keep some room for draws and bluffs.
      if (cat === CATEGORY.HIGH_CARD) return rand() < Math.pow(0.3, m.postAggr);
      if (cat === CATEGORY.PAIR && m.postAggr >= 2) return rand() < 0.55;
    }
    return true;
  };

  let total = 0;
  for (let it = 0; it < iterations; it++) {
    let n = deck.length;
    const draw = () => {
      const j = (rand() * n) | 0;
      const c = deck[j];
      deck[j] = deck[n - 1];
      deck[n - 1] = c;
      n--;
      return c;
    };

    for (let k = 0; k < nOpp; k++) {
      let a;
      let b;
      for (let tries = 0; ; tries++) {
        a = draw();
        b = draw();
        if (tries >= 12 || accepts(a, b, models[k])) break;
        n += 2; // put both back into the pool
      }
      holes[2 * k] = a;
      holes[2 * k + 1] = b;
    }
    for (let i = 0; i < need; i++) {
      const c = draw();
      hero[2 + board.length + i] = c;
      opp[2 + board.length + i] = c;
    }

    const heroScore = evaluate(hero);
    let best = -1;
    let ties = 0;
    for (let k = 0; k < nOpp; k++) {
      opp[0] = holes[2 * k];
      opp[1] = holes[2 * k + 1];
      const s = evaluate(opp);
      if (s > best) {
        best = s;
        ties = 1;
      } else if (s === best) ties++;
    }
    if (heroScore > best) total += 1;
    else if (heroScore === best) total += 1 / (ties + 1);
  }
  return total / iterations;
}

/** What a bot infers about an opponent's holding from the actions taken this hand. */
export function opponentModel(o, game) {
  let range = 1;
  const pre = o.actions.filter((a) => a.street === 'preflop');
  const raises = pre.filter((a) => a.type === 'raise' || a.type === 'bet').length;
  if (raises >= 3) range = 0.05;
  else if (raises === 2) range = 0.09;
  else if (raises === 1) range = 0.22;
  else if (pre.some((a) => a.type === 'call')) range = 0.5;
  // Short stacks shove much wider.
  if (raises > 0 && pre.some((a) => a.allIn) && o.startChips / game.bigBlind < 15) range = Math.max(range, 0.4);
  const postAggr = o.actions.filter((a) => a.street !== 'preflop' && (a.type === 'bet' || a.type === 'raise')).length;
  return { range, postAggr };
}

// ------------------------------------------------------------ decisions

const OPEN_BY_PLAYERS_BEHIND = [1, 0.62, 0.45, 0.33, 0.25, 0.2, 0.16, 0.14];
const PUSH_BY_PLAYERS_BEHIND = [6, 3.5, 2.2, 1.6, 1.25, 1, 0.9, 0.8];

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function chipUnit(bb) {
  const units = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];
  let u = 5;
  for (const x of units) if (x <= bb / 4) u = x;
  return u;
}

function playersBehind(player, game) {
  return game.players.filter((o) => o !== player && o.inHand && !o.folded && !o.allIn && !o.actedThisStreet)
    .length;
}

/**
 * Chooses an action for a computer player.
 * @returns {{type: string, amount?: number}}
 */
export function decide(player, legal, game, difficulty = 'normal', rand = Math.random) {
  const d = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
  const s = STYLES[player.style] ?? STYLES.pro;
  const bb = game.bigBlind;
  const unit = chipUnit(bb);
  const stack = player.chips + player.bet; // chips behind including what is already in this street

  const check = () => (legal.canCheck ? { type: 'check' } : { type: 'fold' });
  const call = () => (legal.canCheck ? { type: 'check' } : { type: 'call' });
  const allIn = () => (legal.canRaise ? { type: 'allin' } : call());
  const raiseTo = (amount) => {
    if (!legal.canRaise) return call();
    let to = Math.round(amount / unit) * unit;
    to = clamp(to, legal.minRaiseTo, legal.maxRaiseTo);
    if (to >= legal.maxRaiseTo * 0.85) to = legal.maxRaiseTo; // don't leave a pointless sliver behind
    return { type: 'raise', amount: to };
  };

  // Easy bots occasionally just click something.
  if (d.mistakes && rand() < d.mistakes) {
    return legal.canCheck ? { type: 'check' } : rand() < 0.6 ? call() : check();
  }

  const ctx = { player, legal, game, d, s, bb, stack, rand, check, call, allIn, raiseTo };
  return game.street === 'preflop' ? preflop(ctx) : postflop(ctx);
}

function preflop({ player, legal, game, d, s, bb, stack, rand, check, call, allIn, raiseTo }) {
  const opps = game.contenders.filter((o) => o !== player);
  const looseness = 1.45 - 0.9 * s.tight;
  const p = clamp(preflopPercentile(player.hole[0], player.hole[1]) + (rand() - 0.5) * d.noise * 0.6, 0, 1);
  const behind = Math.min(playersBehind(player, game), 7);
  const stackBB = stack / bb;
  const raises = game.raisesThisStreet;

  if (raises === 0) {
    const limpers = opps.filter((o) => o.actions.some((a) => a.street === 'preflop' && a.type === 'call')).length;
    if (stackBB <= 13) {
      const pushRange = clamp((1.6 / stackBB) * PUSH_BY_PLAYERS_BEHIND[behind] * looseness, 0.05, 0.92);
      if (p <= pushRange) return allIn();
      return check();
    }
    const openRange = clamp(OPEN_BY_PLAYERS_BEHIND[behind] * looseness, 0.04, 0.95) * (limpers ? 0.75 : 1);
    if (p <= openRange) {
      if (rand() < 0.3 + 0.7 * s.aggr || p < openRange * 0.25) {
        return raiseTo(bb * (2.2 + 0.6 * s.aggr + rand() * 0.4 + limpers));
      }
      return call();
    }
    if (legal.canCheck) return { type: 'check' };
    // Completing the small blind or limping along is cheap for loose players.
    const cheap = legal.toCall <= bb / 2;
    if ((cheap && p <= 0.55 * looseness) || (p <= openRange * 1.6 && rand() < (1 - s.tight) * (1 - s.aggr) * 0.7)) {
      return call();
    }
    return check();
  }

  // Facing a raise: weigh equity against the ranges of the players who put money in.
  const involved = opps.filter((o) => o.actions.some((a) => a.street === 'preflop' && a.type !== 'check') || o.allIn);
  const models = involved.map((o) => (d.modelRanges ? opponentModel(o, game) : WIDE));
  const eq = estimateEquity(player.hole, [], models, Math.round(d.iterations * 0.6), rand) + (rand() - 0.5) * d.noise;
  const pot = legal.pot;
  const potOdds = legal.toCall / (pot + legal.toCall);

  const reraiseRange = (raises === 1 ? 0.045 + 0.05 * s.aggr : raises === 2 ? 0.02 + 0.015 * s.aggr : 0.012) * looseness;
  const lightReraise = raises === 1 && behind <= 2 && p > 0.08 && p < 0.3 && rand() < s.bluff * 0.5;
  if (legal.canRaise && (p <= reraiseRange || lightReraise)) {
    const target = legal.currentBet * (raises === 1 ? 3 : 2.4) + (rand() * 0.5 * bb);
    if (target >= stack * 0.4 || raises >= 3) return allIn();
    return raiseTo(target);
  }

  // Implied odds: cheap calls with pairs and suited connectors when stacks are deep.
  const r1 = rankOf(player.hole[0]);
  const r2 = rankOf(player.hole[1]);
  const speculative = r1 === r2 || (suitOf(player.hole[0]) === suitOf(player.hole[1]) && Math.abs(r1 - r2) <= 2);
  const implied = speculative && legal.toCall <= stack * 0.07 ? 0.06 : 0;
  const margin = 0.02 + 0.06 * s.tight - s.sticky - implied + 0.015 * behind;
  if (eq >= potOdds + margin) return call();
  return check();
}

function postflop({ player, legal, game, d, s, stack, rand, check, call, allIn, raiseTo }) {
  const opps = game.contenders.filter((o) => o !== player);
  const n = opps.length;
  const models = opps.map((o) => (d.modelRanges ? opponentModel(o, game) : WIDE));
  const eq = clamp(estimateEquity(player.hole, game.board, models, d.iterations, rand) + (rand() - 0.5) * d.noise, 0, 1);
  const base = 1 / (n + 1);
  const strength = (eq - base) / (1 - base); // 0 = average share of the pot, 1 = lock
  const pot = legal.pot;
  const river = game.street === 'river';
  const raises = game.raisesThisStreet;
  const preflopAggressor = player.actions.some((a) => a.street === 'preflop' && (a.type === 'raise' || a.type === 'bet'));

  const betSize = (frac) => {
    const amount = pot * clamp(frac + (rand() - 0.5) * 0.15, 0.3, 1.2);
    // With a strong hand and a short stack, just get it in.
    if (amount >= stack * 0.55 && strength > 0.45) return allIn();
    return raiseTo(amount);
  };

  if (legal.canCheck) {
    if (!legal.canRaise) return { type: 'check' };
    const valueThreshold = 0.22 + 0.2 * s.tight - 0.12 * s.aggr + (n - 1) * 0.05;
    if (strength > valueThreshold) {
      const slowplay = strength > 0.8 && !river && rand() < 0.25;
      if (!slowplay && rand() < 0.55 + 0.45 * s.aggr) return betSize(0.45 + 0.4 * strength);
      return { type: 'check' };
    }
    if (game.street === 'flop' && preflopAggressor && n <= 2 && rand() < 0.3 + 0.45 * s.aggr) {
      return betSize(0.4);
    }
    if (n <= 2 && rand() < s.bluff * (river ? 0.7 : 1) * (n === 1 ? 1 : 0.5)) {
      const bluff = betSize(0.55);
      return bluff.type === 'allin' ? { type: 'check' } : bluff;
    }
    return { type: 'check' };
  }

  // Facing a bet.
  const potOdds = legal.toCall / (pot + legal.toCall);
  const raiseThreshold = 0.48 + 0.15 * s.tight - 0.12 * s.aggr + 0.14 * Math.max(0, raises - 1) + (n - 1) * 0.05;
  if (legal.canRaise && raises < 4 && strength > raiseThreshold && rand() < 0.35 + 0.55 * s.aggr) {
    const target = legal.currentBet * 2.6 + pot * 0.25;
    if (target >= stack * 0.5) return allIn();
    return raiseTo(target);
  }

  const drawing = !river ? 0.04 : 0;
  const margin = 0.03 + 0.07 * s.tight - s.sticky - drawing + (raises >= 2 ? 0.05 : 0);
  if (eq >= potOdds + margin) return call();

  if (!river && legal.canRaise && n === 1 && raises === 1 && rand() < s.bluff * 0.3) {
    const target = legal.currentBet * 2.5;
    if (target < stack * 0.4) return raiseTo(target);
  }
  return check();
}

/** Equity against opponents whose cards are face up (all-in runouts): only the board is unknown. */
export function equityVsKnown(hole, oppHoles, board, iterations = 2000, rand = Math.random) {
  const known = new Set([...hole, ...oppHoles.flat(), ...board]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  const need = 5 - board.length;
  const runs = need === 0 ? 1 : iterations;
  const hero = [...hole, ...board, 0, 0, 0, 0, 0].slice(0, 7);
  const opps = oppHoles.map((h) => [...h, ...board, 0, 0, 0, 0, 0].slice(0, 7));
  let total = 0;
  for (let it = 0; it < runs; it++) {
    let n = deck.length;
    for (let i = 0; i < need; i++) {
      const j = (rand() * n) | 0;
      const c = deck[j];
      deck[j] = deck[n - 1];
      deck[n - 1] = c;
      n--;
      hero[2 + board.length + i] = c;
      for (const o of opps) o[2 + board.length + i] = c;
    }
    const mine = evaluate(hero);
    let best = -1;
    let ties = 0;
    for (const o of opps) {
      const sc = evaluate(o);
      if (sc > best) {
        best = sc;
        ties = 1;
      } else if (sc === best) ties++;
    }
    if (mine > best) total += 1;
    else if (mine === best) total += 1 / (ties + 1);
  }
  return total / runs;
}

/** Win probability shown to the player (opponents assumed to hold random hands). */
export function displayEquity(hole, board, opponents, iterations = 1200) {
  return estimateEquity(hole, board, Array.from({ length: opponents }, () => WIDE), iterations);
}
