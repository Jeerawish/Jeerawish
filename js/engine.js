// No-limit Texas Hold'em engine. UI-agnostic: it drives a hand through async hooks
//   hooks.getAction(player, legal, game) -> Promise<{ type, amount? }>
//   hooks.emit(type, payload)            -> Promise (lets the UI animate before play continues)

import { Deck } from './cards.js';
import { evaluate, bestHand } from './evaluator.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river'];

// Blind levels for a 2,000-chip starting stack scale (10/20 = 100 big blinds).
export const BLIND_LEVELS = [
  [10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [75, 150], [100, 200],
  [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [700, 1400], [1000, 2000],
  [1500, 3000], [2000, 4000], [3000, 6000], [5000, 10000], [7500, 15000], [10000, 20000],
];

const noop = async () => {};

export class PokerGame {
  constructor(opts) {
    this.players = opts.players.map((p, i) => ({
      id: p.id ?? `p${i}`,
      name: p.name,
      chips: p.chips,
      isHuman: !!p.isHuman,
      avatar: p.avatar ?? '',
      style: p.style ?? null,
      eliminated: p.eliminated ?? p.chips <= 0,
      place: p.place ?? null,
      seat: i,
      hole: [],
      inHand: false,
      folded: false,
      allIn: false,
      bet: 0,
      totalBet: 0,
      hasActed: false,
      actedThisStreet: false,
      lastFacedBet: 0,
      lastAction: null,
      actions: [],
    }));
    this.blindLevels = opts.blindLevels ?? BLIND_LEVELS;
    this.handsPerLevel = opts.handsPerLevel ?? 0;
    this.levelIndex = opts.levelIndex ?? 0;
    this.handNumber = opts.handNumber ?? 0;
    this.dealerIndex = opts.dealerIndex ?? -1;
    this.deckFactory = opts.deckFactory ?? (() => new Deck());
    this.hooks = { getAction: opts.getAction, emit: opts.emit ?? noop };

    this.board = [];
    this.street = null;
    this.currentBet = 0;
    this.minRaise = 0;
    this.sbIndex = -1;
    this.bbIndex = -1;
    this.toAct = -1;
    this.raisesThisStreet = 0;
    this.handInProgress = false;
  }

  // ---------------------------------------------------------------- queries

  get smallBlind() {
    return this.blindLevels[this.levelIndex][0];
  }

  get bigBlind() {
    return this.blindLevels[this.levelIndex][1];
  }

  get activePlayers() {
    return this.players.filter((p) => !p.eliminated);
  }

  /** Players still contesting the pot. */
  get contenders() {
    return this.players.filter((p) => p.inHand && !p.folded);
  }

  /** Players who can still make betting decisions. */
  get actors() {
    return this.players.filter(canAct);
  }

  get pot() {
    let total = 0;
    for (const p of this.players) total += p.totalBet - p.bet;
    return total;
  }

  /** Pot including the bets currently in front of players. */
  get totalPot() {
    let total = 0;
    for (const p of this.players) total += p.totalBet;
    return total;
  }

  get isOver() {
    return this.activePlayers.length <= 1;
  }

  nextIndex(from, predicate) {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const i = (((from + step) % n) + n) % n;
      if (predicate(this.players[i])) return i;
    }
    return -1;
  }

  /** Index of the seat the button would move to next hand (skipping busted players). */
  upcomingDealer() {
    return this.nextIndex(this.dealerIndex, (p) => !p.eliminated);
  }

  /** Hands remaining at the current level, counting the one in progress. */
  handsUntilLevelUp() {
    const n = this.handsPerLevel;
    if (!n || this.levelIndex >= this.blindLevels.length - 1) return Infinity;
    return n - ((this.handNumber - 1) % n);
  }

  legalActions(p) {
    const owed = Math.max(0, this.currentBet - p.bet);
    const toCall = Math.min(owed, p.chips);
    const maxRaiseTo = p.bet + p.chips;
    // Betting is reopened for a player only by a full raise (or several that add up to one).
    const reopened = !p.actedThisStreet || this.currentBet - p.lastFacedBet >= this.minRaise;
    const someoneCanRespond = this.players.some((o) => o !== p && canAct(o));
    const canRaise = p.chips > owed && reopened && someoneCanRespond;
    return {
      canCheck: owed === 0,
      canCall: owed > 0,
      toCall,
      callIsAllIn: owed > 0 && owed >= p.chips,
      canRaise,
      isBet: this.currentBet === 0,
      minRaiseTo: Math.min(this.currentBet + this.minRaise, maxRaiseTo),
      maxRaiseTo,
      currentBet: this.currentBet,
      pot: this.totalPot,
      bigBlind: this.bigBlind,
    };
  }

  // ---------------------------------------------------------------- hand flow

  async playHand() {
    if (this.isOver) throw new Error('Not enough players to deal a hand');
    this.handInProgress = true;
    await this.beginHand();

    for (const street of STREETS) {
      if (street !== 'preflop') {
        if (this.contenders.length < 2) break;
        this.dealStreet(street);
        await this.emit('street', { street, board: this.board.slice() });
      }
      await this.bettingRound(street);
      await this.endBettingRound();
      if (this.contenders.length < 2) break;
      if (!this.revealed && this.actors.length < 2) {
        // Nobody left to bet against: show the hands and run the board out.
        this.revealed = true;
        await this.emit('reveal', { players: this.contenders });
      }
    }

    const result = this.showdown();
    await this.emit('showdown', result);
    for (const [id, amount] of Object.entries(result.payouts)) {
      this.playerById(id).chips += amount;
    }
    const summary = this.finishHand(result);
    this.handInProgress = false;
    await this.emit('handEnd', summary);
    return summary;
  }

  async beginHand() {
    this.handNumber++;
    if (
      this.handsPerLevel > 0 &&
      this.handNumber > 1 &&
      (this.handNumber - 1) % this.handsPerLevel === 0 &&
      this.levelIndex < this.blindLevels.length - 1
    ) {
      this.levelIndex++;
      await this.emit('levelUp', { level: this.levelIndex, sb: this.smallBlind, bb: this.bigBlind });
    }

    this.board = [];
    this.street = 'preflop';
    this.revealed = false;
    this.raisesThisStreet = 0;
    for (const p of this.players) {
      if (p.chips <= 0) p.eliminated = true;
      p.inHand = !p.eliminated;
      p.hole = [];
      p.folded = false;
      p.allIn = false;
      p.bet = 0;
      p.totalBet = 0;
      p.hasActed = false;
      p.actedThisStreet = false;
      p.lastFacedBet = 0;
      p.lastAction = null;
      p.actions = [];
      p.startChips = p.chips;
    }

    this.dealerIndex = this.nextIndex(this.dealerIndex, (p) => p.inHand);
    const headsUp = this.contenders.length === 2;
    this.sbIndex = headsUp ? this.dealerIndex : this.nextIndex(this.dealerIndex, (p) => p.inHand);
    this.bbIndex = this.nextIndex(this.sbIndex, (p) => p.inHand);

    await this.emit('handStart', {
      handNumber: this.handNumber,
      dealerIndex: this.dealerIndex,
      sbIndex: this.sbIndex,
      bbIndex: this.bbIndex,
      sb: this.smallBlind,
      bb: this.bigBlind,
    });

    this.postBlind(this.players[this.sbIndex], this.smallBlind, 'sb');
    this.postBlind(this.players[this.bbIndex], this.bigBlind, 'bb');
    // A short big blind still sets the full amount others must call.
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    await this.emit('blinds', {
      sb: { player: this.players[this.sbIndex], amount: this.players[this.sbIndex].bet },
      bb: { player: this.players[this.bbIndex], amount: this.players[this.bbIndex].bet },
    });

    this.deck = this.deckFactory();
    for (let round = 0; round < 2; round++) {
      let i = this.sbIndex;
      for (let k = 0; k < this.contenders.length; k++) {
        this.players[i].hole.push(this.deck.draw());
        i = this.nextIndex(i, (p) => p.inHand);
      }
    }
    await this.emit('deal', { order: this.dealOrder() });
  }

  dealOrder() {
    const order = [];
    let i = this.sbIndex;
    const n = this.contenders.length;
    for (let k = 0; k < n; k++) {
      order.push(i);
      i = this.nextIndex(i, (p) => p.inHand);
    }
    return order;
  }

  postBlind(p, amount, kind) {
    const paid = Math.min(amount, p.chips);
    this.commit(p, paid);
    p.lastAction = { type: kind, amount: paid };
  }

  commit(p, amount) {
    p.chips -= amount;
    p.bet += amount;
    p.totalBet += amount;
    if (p.chips === 0) p.allIn = true;
  }

  dealStreet(street) {
    this.street = street;
    this.deck.burn();
    const n = street === 'flop' ? 3 : 1;
    for (let i = 0; i < n; i++) this.board.push(this.deck.draw());
  }

  async bettingRound(street) {
    this.street = street;
    this.raisesThisStreet = 0;
    if (street !== 'preflop') {
      for (const p of this.players) {
        p.bet = 0;
        p.hasActed = false;
        p.actedThisStreet = false;
        p.lastFacedBet = 0;
        if (p.inHand && !p.folded && !p.allIn) p.lastAction = null;
      }
      this.currentBet = 0;
      this.minRaise = this.bigBlind;
    }
    let i = this.nextIndex(street === 'preflop' ? this.bbIndex : this.dealerIndex, canAct);

    while (i >= 0 && this.contenders.length > 1 && !this.isRoundComplete()) {
      const p = this.players[i];
      this.toAct = i;
      const legal = this.legalActions(p);
      await this.emit('turn', { player: p, legal });
      const action = await this.hooks.getAction(p, legal, this);
      const applied = this.applyAction(p, action);
      await this.emit('action', { player: p, action: applied });
      i = this.nextIndex(i, canAct);
    }
    this.toAct = -1;
  }

  isRoundComplete() {
    const actors = this.actors;
    if (actors.length === 0) return true;
    if (actors.length === 1) {
      // Nobody left to bet against; done once the last player has matched the bet.
      return actors[0].bet >= this.currentBet || this.contenders.length === 1;
    }
    return actors.every((p) => p.hasActed && p.bet === this.currentBet);
  }

  /** Validates and applies an action. Returns the normalized action that was taken. */
  applyAction(p, action) {
    if (!canAct(p)) throw new Error(`${p.name} cannot act`);
    const legal = this.legalActions(p);
    let { type } = action;
    let result;

    if (type === 'allin') {
      type = legal.canRaise && legal.maxRaiseTo > this.currentBet ? 'raise' : 'call';
      action = { type, amount: legal.maxRaiseTo };
    }

    switch (type) {
      case 'fold':
        p.folded = true;
        result = { type: 'fold' };
        break;
      case 'check':
        if (!legal.canCheck) throw new Error(`${p.name} cannot check facing ${legal.toCall}`);
        result = { type: 'check' };
        break;
      case 'call': {
        if (legal.canCheck) {
          result = { type: 'check' };
          break;
        }
        this.commit(p, legal.toCall);
        result = { type: 'call', amount: legal.toCall, total: p.bet };
        break;
      }
      case 'raise':
      case 'bet': {
        if (!legal.canRaise) throw new Error(`${p.name} cannot raise`);
        let to = Math.round(Number(action.amount));
        if (!Number.isFinite(to)) throw new Error('Raise amount required');
        to = Math.max(legal.minRaiseTo, Math.min(to, legal.maxRaiseTo));
        const raiseSize = to - this.currentBet;
        if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
        this.commit(p, to - p.bet);
        this.currentBet = Math.max(this.currentBet, to);
        this.raisesThisStreet++;
        for (const o of this.players) if (o !== p && canAct(o)) o.hasActed = false;
        result = { type: legal.isBet ? 'bet' : 'raise', amount: to, total: to };
        break;
      }
      default:
        throw new Error(`Unknown action: ${type}`);
    }

    p.hasActed = true;
    p.actedThisStreet = true;
    p.lastFacedBet = this.currentBet;
    result.allIn = p.allIn && result.type !== 'fold' && result.type !== 'check';
    p.lastAction = result;
    p.actions.push({ street: this.street, ...result });
    return result;
  }

  /** Returns any uncalled portion of the largest bet, then moves bets into the pot. */
  async endBettingRound() {
    let refund = null;
    const bettors = this.players.filter((p) => p.bet > 0);
    if (bettors.length) {
      const top = bettors.reduce((a, b) => (b.bet > a.bet ? b : a));
      const second = this.players.reduce((m, p) => (p !== top ? Math.max(m, p.bet) : m), 0);
      if (top.bet > second) {
        const amount = top.bet - second;
        top.bet -= amount;
        top.totalBet -= amount;
        top.chips += amount;
        if (top.chips > 0) top.allIn = false;
        refund = { player: top, amount };
      }
    }
    const hadBets = this.players.some((p) => p.bet > 0);
    await this.emit('collect', { refund, hadBets });
    for (const p of this.players) p.bet = 0;
  }

  /** Splits contributions into main and side pots. */
  computePots() {
    const remaining = this.players.map((p) => ({ p, amt: p.totalBet }));
    const pots = [];
    for (;;) {
      const live = remaining.filter((r) => r.amt > 0 && r.p.inHand && !r.p.folded);
      if (!live.length) {
        const dead = remaining.reduce((s, r) => s + r.amt, 0);
        if (dead > 0) {
          if (pots.length) pots[pots.length - 1].amount += dead;
          else pots.push({ amount: dead, eligible: this.contenders.map((p) => p.id) });
        }
        break;
      }
      const level = Math.min(...live.map((r) => r.amt));
      let amount = 0;
      for (const r of remaining) {
        const take = Math.min(r.amt, level);
        amount += take;
        r.amt -= take;
      }
      const eligible = live.map((r) => r.p.id);
      const last = pots[pots.length - 1];
      if (last && sameMembers(last.eligible, eligible)) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    return pots;
  }

  showdown() {
    this.street = 'showdown';
    const contenders = this.contenders;
    const payouts = {};
    const hands = {};

    if (contenders.length === 1) {
      const winner = contenders[0];
      const amount = this.totalPot;
      payouts[winner.id] = amount;
      return {
        uncontested: true,
        pots: [{ amount, eligible: [winner.id], winners: [winner.id], shares: { [winner.id]: amount } }],
        hands,
        payouts,
        board: this.board.slice(),
      };
    }

    for (const p of contenders) {
      const best = bestHand([...p.hole, ...this.board]);
      hands[p.id] = { score: evaluate([...p.hole, ...this.board]), ...best };
    }

    // Odd chips go to the first winner clockwise from the button.
    const order = [];
    for (let k = 1; k <= this.players.length; k++) {
      order.push(this.players[(this.dealerIndex + k) % this.players.length].id);
    }

    const pots = this.computePots().map((pot) => {
      const best = Math.max(...pot.eligible.map((id) => hands[id].score));
      const winners = pot.eligible
        .filter((id) => hands[id].score === best)
        .sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      const shares = {};
      for (const id of winners) {
        const amt = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        shares[id] = amt;
        payouts[id] = (payouts[id] || 0) + amt;
      }
      return { ...pot, winners, shares };
    });

    return { uncontested: false, pots, hands, payouts, board: this.board.slice() };
  }

  finishHand(result) {
    const busted = this.players
      .filter((p) => p.inHand && p.chips === 0)
      .sort((a, b) => b.startChips - a.startChips);
    const survivors = this.players.filter((p) => !p.eliminated && p.chips > 0).length;
    busted.forEach((p, i) => {
      p.eliminated = true;
      p.place = survivors + 1 + i;
    });
    if (survivors === 1) {
      const champ = this.players.find((p) => !p.eliminated);
      champ.place = 1;
    }
    return {
      handNumber: this.handNumber,
      result,
      busted,
      gameOver: survivors <= 1,
    };
  }

  playerById(id) {
    return this.players.find((p) => p.id === id);
  }

  emit(type, payload) {
    return this.hooks.emit(type, payload, this);
  }

  // ---------------------------------------------------------------- persistence

  /** Serializable state between hands. */
  toJSON() {
    return {
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        isHuman: p.isHuman,
        avatar: p.avatar,
        style: p.style,
        eliminated: p.eliminated,
        place: p.place,
      })),
      levelIndex: this.levelIndex,
      handNumber: this.handNumber,
      dealerIndex: this.dealerIndex,
      handsPerLevel: this.handsPerLevel,
    };
  }
}

function canAct(p) {
  return p.inHand && !p.folded && !p.allIn;
}

function sameMembers(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
