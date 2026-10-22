// Table rendering, animations and the player's controls.

import { RANK_LABELS, SUITS, SUIT_SYMBOLS, rankOf, suitOf, cardName, parseCards } from './cards.js';
import { describePartial } from './evaluator.js';
import { displayEquity, equityVsKnown } from './ai.js';

const TEXT_VS = '︎'; // keep suit symbols as text glyphs, not emoji (iOS)

// Seat angles in degrees (0 = right, 90 = bottom), clockwise from the player at the bottom.
const SEAT_ANGLES = {
  2: [90, 270],
  3: [90, 212, 328],
  4: [90, 180, 270, 0],
  5: [90, 158, 228, 312, 22],
  6: [90, 148, 210, 270, 330, 32],
};

const CHIP_COLORS = [
  [10000, '#ef6c1a'],
  [5000, '#c2185b'],
  [1000, '#e2b714'],
  [500, '#7b3fb3'],
  [100, '#20252e'],
  [25, '#1d9a57'],
  [5, '#d32f3f'],
  [1, '#dfe3e6'],
];

const SPEED = { slow: 1.45, normal: 1, fast: 0.6, turbo: 0.32 };

export const fmt = (n) => Math.round(n).toLocaleString('en-US');
/** True when the player should be addressed as "you" (default hero name). */
export const isYou = (p) => p.isHuman && p.name === 'You';

/** Thrown into a stale game's async flow after the table was rebuilt for a new game. */
export class StaleTable extends Error {}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function chipUnit(bb) {
  const units = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];
  let u = 5;
  for (const x of units) if (x <= bb / 4) u = x;
  return u;
}

// ------------------------------------------------------------------ elements

export function cardEl(card = null, { faceUp = false, cls = '' } = {}) {
  const el = document.createElement('div');
  el.className = `card ${cls}`.trim();
  el.innerHTML =
    '<div class="card__inner"><div class="card__face card__front"></div><div class="card__face card__back"></div></div>';
  el.setAttribute('role', 'img');
  if (card != null) setCardFace(el, card);
  else el.setAttribute('aria-label', 'Face-down card');
  if (faceUp) el.classList.add('is-faceup');
  return el;
}

export function setCardFace(el, card) {
  const r = rankOf(card);
  const s = suitOf(card);
  const front = el.querySelector('.card__front');
  front.dataset.suit = SUITS[s];
  const sym = SUIT_SYMBOLS[s] + TEXT_VS;
  front.innerHTML =
    `<span class="card__corner"><span class="card__rank${r === 8 ? ' card__rank--ten' : ''}">${RANK_LABELS[r]}</span>` +
    `<span class="card__suit">${sym}</span></span><span class="card__pip">${sym}</span>`;
  el.dataset.card = card;
  el.setAttribute('aria-label', cardName(card));
}

function chipColors(amount, max = 5) {
  const colors = [];
  let rest = amount;
  for (const [value, color] of CHIP_COLORS) {
    while (rest >= value && colors.length < max) {
      colors.push(color);
      rest -= value;
    }
  }
  return colors.length ? colors : [CHIP_COLORS[CHIP_COLORS.length - 1][1]];
}

function chipStackEl(amount, max = 5) {
  const stack = document.createElement('span');
  stack.className = 'chips';
  chipColors(amount, max).reverse().forEach((c, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--c', c);
    chip.style.top = `${-i * 3}px`;
    stack.prepend(chip);
  });
  return stack;
}

/** Inline text for a card, colored by suit, for logs. */
export function cardText(card) {
  const s = suitOf(card);
  const cls = s === 1 || s === 2 ? 'suit-r' : 'suit-b';
  return `<span class="${cls} suit-${SUITS[s]}">${RANK_LABELS[rankOf(card)]}${SUIT_SYMBOLS[s]}${TEXT_VS}</span>`;
}

// ------------------------------------------------------------------ table UI

export class TableUI {
  constructor({ settings, sound }) {
    this.settings = settings;
    this.sound = sound;
    const $ = (id) => document.getElementById(id);
    this.el = {
      wrap: $('table-wrap'),
      table: $('table'),
      felt: $('felt'),
      board: $('board'),
      pot: $('pot'),
      potAmount: $('pot-amount'),
      potChips: $('pot-chips'),
      sidePots: $('side-pots'),
      seats: $('seats'),
      dealer: $('dealer-btn'),
      fx: $('fx'),
      message: $('table-message'),
      controls: $('controls'),
      heroHand: $('hero-hand'),
      heroOdds: $('hero-odds'),
      fold: $('act-fold'),
      call: $('act-call'),
      raise: $('act-raise'),
      actions: $('actions'),
      raisePanel: $('raise-panel'),
      presets: $('raise-presets'),
      slider: $('raise-slider'),
      minus: $('raise-minus'),
      plus: $('raise-plus'),
      amount: $('raise-amount'),
      preactions: $('preactions'),
      statusText: $('status-text'),
      next: $('btn-next'),
      nextProgress: $('next-progress'),
      blindsLabel: $('blinds-label'),
      levelLabel: $('level-label'),
      toast: $('toast'),
    };
    this.game = null;
    this.seatEls = [];
    this.betEls = [];
    this.slots = [];
    this.pos = null;
    this.pending = null;
    this.pre = null;
    this.raiseTo = 0;
    this.showStreetActions = true;
    this.oddsToken = 0;
    this.shownChips = [];
    this.gen = 0;

    for (let i = 0; i < 5; i++) {
      const slot = document.createElement('div');
      slot.className = 'board__slot';
      this.el.board.append(slot);
      this.slots.push(slot);
    }

    new ResizeObserver(() => this.layout()).observe(this.el.wrap);
    this.bindControls();
  }

  get speed() {
    return SPEED[this.settings.speed] ?? 1;
  }

  /** Waits a duration scaled by game speed; faster when the player is not in the hand. */
  async wait(ms) {
    if (reducedMotion()) ms *= 0.5;
    const hero = this.hero;
    const spectating = hero && (!hero.inHand || hero.folded) && this.game?.handInProgress;
    const gen = this.gen;
    await sleep(ms * this.speed * (spectating ? 0.55 : 1));
    if (gen !== this.gen) throw new StaleTable();
  }

  get hero() {
    return this.game?.players.find((p) => p.isHuman);
  }

  // ---------------------------------------------------------------- setup & layout

  setup(game) {
    this.gen++;
    this.game = game;
    this.hideMessage();
    this.el.seats.innerHTML = '';
    this.seatEls = [];
    this.betEls = [];
    for (const p of game.players) {
      const seat = document.createElement('div');
      seat.className = `seat${p.isHuman ? ' seat--hero' : ''}`;
      seat.innerHTML = `
        <div class="seat__body">
          <div class="seat__cards"></div>
          <div class="seat__avatar" aria-hidden="true">${p.avatar}
            <span class="seat__thinking"><i></i><i></i><i></i></span>
          </div>
          <span class="seat__badge"></span>
        </div>
        <div class="seat__plate">
          <span class="seat__action"></span>
          <span class="seat__name"></span>
          <span class="seat__chips"></span>
          <span class="seat__hand"></span>
        </div>`;
      const bet = document.createElement('div');
      bet.className = 'bet is-empty num';
      this.el.seats.append(seat, bet);
      this.seatEls.push(seat);
      this.betEls.push(bet);
    }
    this.clearBoard();
    this.layout();
    this.renderAll();
    this.setControls('idle', 'Shuffling up…');
  }

  layout() {
    const game = this.game;
    if (!game) return;
    const W = this.el.wrap.clientWidth;
    const H = this.el.wrap.clientHeight;
    if (!W || !H) return;
    const portrait = H > W * 1.05;
    const n = game.players.length;

    let cardW = portrait ? Math.min(W * 0.13, H * 0.085) : Math.min(H * 0.15, W * 0.085);
    cardW = Math.round(clamp(cardW, 34, 100));
    const ui = clamp(cardW / 54, 0.85, 1.55); // scales seat text, chips and badges with the table
    const seatCardW = Math.round(cardW * 0.6);
    const heroCardW = Math.round(clamp(cardW * (portrait ? 1.22 : 1.05), 44, 116));
    const avatar = Math.round(clamp(cardW * 0.92, 36, 86));
    const seatW = Math.round(Math.max(avatar * 1.85, 76 * ui));
    const t = this.el.table.style;
    t.setProperty('--ui', ui.toFixed(3));
    t.setProperty('--card-w', `${cardW}px`);
    t.setProperty('--seat-card-w', `${seatCardW}px`);
    t.setProperty('--hero-card-w', `${heroCardW}px`);
    t.setProperty('--avatar', `${avatar}px`);
    t.setProperty('--seat-w', `${seatW}px`);

    const seatH = avatar + seatCardW * 1.4 * 0.62 + 30 * ui;
    const heroH = heroCardW * 1.4 + 34 * ui;
    const insetX = portrait ? Math.max(seatW * 0.42, W * 0.09) : Math.max(seatW * 0.6, W * 0.07);
    const insetTop = seatH * 0.52;
    const insetBottom = heroH * 0.5;
    const felt = this.el.felt.style;
    felt.left = `${insetX}px`;
    felt.right = `${insetX}px`;
    felt.top = `${insetTop}px`;
    felt.bottom = `${insetBottom}px`;
    felt.setProperty('--rail', `${Math.round(clamp(cardW * 0.22, 8, 16))}px`);

    const fw = W - 2 * insetX;
    const fh = H - insetTop - insetBottom;
    const cx = W / 2;
    const cy = insetTop + fh / 2;
    const rx = fw / 2 + 4;
    const ry = fh / 2 + 6;

    const angles = SEAT_ANGLES[n] ?? SEAT_ANGLES[6];
    const heroIndex = Math.max(0, game.players.findIndex((p) => p.isHuman));
    const cardH = cardW * 1.4;
    // Portrait: pot under the board, messages above it. Landscape: the other way round.
    const potDy = (portrait ? 1 : -1) * (cardH / 2 + 20);
    const msgDy = portrait ? -(cardH / 2 + 24) : potDy;
    this.el.table.classList.toggle('msg-over-pot', !portrait);
    t.setProperty('--pot-dy', `${potDy}px`);
    t.setProperty('--msg-dy', `${msgDy}px`);
    t.setProperty('--logo-dy', `${portrait ? msgDy : cardH / 2 + 22}px`);
    const potBox = { x: cx, y: cy + potDy, w: 130, h: 30 };
    const seats = [];
    const bets = [];
    const dealers = [];

    for (let i = 0; i < n; i++) {
      const rel = (i - heroIndex + n) % n;
      const a = (angles[rel] * Math.PI) / 180;
      let x;
      let y;
      if (rel === 0) {
        x = cx;
        y = H - heroH / 2 - 2;
      } else {
        x = clamp(cx + rx * Math.cos(a), seatW / 2 + 2, W - seatW / 2 - 2);
        y = clamp(cy + ry * Math.sin(a), seatH / 2, H - seatH / 2);
      }
      seats.push({ x, y });

      if (rel === 0) {
        bets.push({ x: cx, y: H - heroH - 14 });
        dealers.push({ x: cx - heroCardW * 1.35, y: H - heroH * 0.62 });
        continue;
      }
      // Bets sit just in front of the seat, toward the middle of the table.
      const dx = cx - x;
      const dy = cy - y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const reach = Math.min(len * 0.6, Math.abs(ux) * (seatW / 2 + 24) + Math.abs(uy) * (seatH / 2 + 16));
      let bx = x + ux * reach;
      let by = y + uy * reach;
      if (Math.abs(bx - potBox.x) < potBox.w / 2 + 34 && Math.abs(by - potBox.y) < potBox.h / 2 + 14) {
        // Would cover the pot: tuck the bet beside the seat instead.
        bx = x + (x >= cx ? -1 : 1) * (seatW / 2 + 34);
        by = y + seatH * 0.18;
      }
      bets.push({ x: bx, y: by });
      // Dealer button: next to the bet, rotated a quarter turn around the seat.
      const side = x > cx + 1 ? -1 : 1;
      dealers.push({ x: x + ux * reach * 0.8 - uy * 44 * side, y: y + uy * reach * 0.8 + ux * 44 * side });
    }

    this.pos = { seats, bets, dealers, center: { x: cx, y: cy }, pot: { x: cx, y: potBox.y }, deck: { x: cx, y: cy - cardH } };
    this.seatEls.forEach((el, i) => {
      el.style.setProperty('--x', `${seats[i].x}px`);
      el.style.setProperty('--y', `${seats[i].y}px`);
    });
    this.betEls.forEach((el, i) => {
      el.style.setProperty('--x', `${bets[i].x}px`);
      el.style.setProperty('--y', `${bets[i].y}px`);
    });
    this.placeDealer();
  }

  placeDealer() {
    const i = this.game?.dealerIndex;
    const d = this.el.dealer;
    if (i == null || i < 0 || !this.pos) {
      d.style.opacity = '0';
      return;
    }
    d.style.opacity = '1';
    d.style.setProperty('--x', `${this.pos.dealers[i].x}px`);
    d.style.setProperty('--y', `${this.pos.dealers[i].y}px`);
  }

  // ---------------------------------------------------------------- rendering

  renderAll() {
    const g = this.game;
    if (!g) return;
    g.players.forEach((_, i) => {
      this.renderSeat(i);
      this.renderBet(i);
    });
    this.renderPot();
    this.renderTopbar();
    this.placeDealer();
  }

  renderTopbar() {
    const g = this.game;
    this.el.blindsLabel.textContent = `Blinds ${fmt(g.smallBlind)}/${fmt(g.bigBlind)}`;
    const left = g.handsUntilLevelUp();
    const handText = `Hand ${Math.max(1, g.handNumber)}`;
    this.el.levelLabel.textContent =
      left === Infinity ? handText : `${handText} · Level ${g.levelIndex + 1} · ${left} to next`;
  }

  renderSeat(i, { chips } = {}) {
    const g = this.game;
    const p = g.players[i];
    const el = this.seatEls[i];
    el.querySelector('.seat__name').textContent = p.name;
    if (chips !== false) {
      this.shownChips[i] = p.chips;
      el.querySelector('.seat__chips').textContent = fmt(p.chips);
    }

    const action = el.querySelector('.seat__action');
    let type = '';
    let label = '';
    if (p.inHand && g.handInProgress) {
      const last = p.actions[p.actions.length - 1];
      if (p.folded) {
        // "Fold" shows on the street it happened; afterwards the dimmed seat says enough.
        if (this.showStreetActions && last?.type === 'fold' && last.street === g.street) [type, label] = ['fold', 'Fold'];
      } else if (p.allIn) [type, label] = ['allin', 'All-in'];
      else if (this.showStreetActions && p.lastAction && !['sb', 'bb'].includes(p.lastAction.type)) {
        type = p.lastAction.type;
        label = { check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' }[type] ?? '';
      }
    }
    if (el.classList.contains('is-winner')) [type, label] = ['win', 'Winner'];
    action.dataset.type = type;
    action.textContent = label;

    el.classList.toggle('is-folded', p.inHand && p.folded && g.handInProgress);
    el.classList.toggle('is-out', p.eliminated);
    const badge = el.querySelector('.seat__badge');
    const kind = g.handInProgress ? (i === g.sbIndex ? 'sb' : i === g.bbIndex ? 'bb' : '') : '';
    badge.dataset.kind = kind;
    badge.textContent = kind.toUpperCase();
    el.setAttribute('aria-label', `${p.name}, ${fmt(p.chips)} chips${label ? `, ${label}` : ''}`);
  }

  renderBet(i) {
    const p = this.game.players[i];
    const el = this.betEls[i];
    if (p.bet > 0) {
      el.classList.remove('is-empty');
      el.replaceChildren(chipStackEl(p.bet, 4), document.createTextNode(fmt(p.bet)));
    } else {
      el.classList.add('is-empty');
      el.replaceChildren();
    }
  }

  renderPot(amount = this.game.pot, collected = this.game.players.every((p) => p.bet === 0)) {
    this.el.potAmount.textContent = fmt(amount);
    this.el.pot.classList.toggle('pot--empty', amount <= 0);
    this.el.potChips.replaceWith((this.el.potChips = chipStackEl(Math.max(amount, 1), 5)));
    this.el.potChips.id = 'pot-chips';
    const pots = this.game.handInProgress && this.game.street !== 'showdown' ? this.game.computePots() : [];
    this.el.sidePots.innerHTML =
      collected && pots.length > 1
        ? pots.map((pt, k) => `<span>${k === 0 ? 'Main' : `Side ${k}`} ${fmt(pt.amount)}</span>`).join('')
        : '';
  }

  clearBoard() {
    this.slots.forEach((s) => s.replaceChildren());
  }

  setControls(mode, text = '') {
    const c = this.el.controls;
    c.classList.toggle('is-idle', mode === 'idle');
    c.classList.toggle('is-waiting', mode === 'waiting');
    if (mode !== 'acting') this.closeRaise();
    if (mode === 'idle') {
      this.el.statusText.textContent = text;
      this.el.statusText.hidden = !text;
      this.el.next.hidden = true;
    }
  }

  message(html, ms = 0) {
    const m = this.el.message;
    m.innerHTML = html;
    m.classList.add('is-visible');
    this.el.table.classList.add('has-message');
    clearTimeout(this.msgTimer);
    if (ms) this.msgTimer = setTimeout(() => this.hideMessage(), ms);
  }

  hideMessage() {
    clearTimeout(this.msgTimer);
    this.el.message.classList.remove('is-visible');
    this.el.table.classList.remove('has-message');
  }

  /** Counts a seat's stack up as winnings land. */
  addShownChips(i, amount) {
    const from = this.shownChips[i] ?? 0;
    this.shownChips[i] = from + amount;
    return this.animateNumber(this.seatEls[i].querySelector('.seat__chips'), from, from + amount, 650);
  }

  toast(text, ms = 2200) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('is-visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('is-visible'), ms);
  }

  setActive(index) {
    this.seatEls.forEach((el, i) => el.classList.toggle('is-active', i === index));
  }

  setThinking(index, on) {
    this.seatEls[index]?.classList.toggle('is-thinking', on);
  }

  updateHeroInfo() {
    const hero = this.hero;
    const g = this.game;
    if (!hero || !hero.hole.length || !g.handInProgress) {
      this.el.heroHand.textContent = '';
      this.el.heroOdds.textContent = '';
      return;
    }
    this.el.heroHand.textContent = describePartial([...hero.hole, ...g.board]);
    this.el.heroOdds.textContent = '';
    const opponents = g.contenders.filter((p) => p !== hero).length;
    if (!this.settings.showOdds || hero.folded || opponents === 0) return;
    const token = ++this.oddsToken;
    const hole = hero.hole.slice();
    const board = g.board.slice();
    // Once hands are face up in an all-in, show the real odds against them.
    const shown = g.revealed ? g.contenders.filter((p) => p !== hero).map((p) => p.hole.slice()) : null;
    setTimeout(() => {
      if (token !== this.oddsToken) return;
      const eq = shown ? equityVsKnown(hole, shown, board) : displayEquity(hole, board, opponents, 1500);
      if (token === this.oddsToken) this.el.heroOdds.textContent = `Win ${Math.round(eq * 100)}%`;
    }, 30);
  }

  // ---------------------------------------------------------------- animation helpers

  /** Flies a few chips from one table point to another. */
  async flyChips(from, to, amount, { duration = 420, count } = {}) {
    if (!from || !to) return;
    const colors = chipColors(amount, count ?? Math.min(4, 1 + Math.floor(Math.log10(Math.max(amount, 1)))));
    const dur = duration * this.speed;
    const anims = colors.map((c, k) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.setProperty('--c', c);
      this.el.fx.append(chip);
      const jitter = () => (Math.random() - 0.5) * 8;
      const a = chip.animate(
        [
          { transform: `translate(${from.x - 10 + jitter()}px, ${from.y - 10 + jitter()}px) scale(0.9)`, opacity: 0.9 },
          { transform: `translate(${to.x - 10 + jitter()}px, ${to.y - 10 + jitter()}px) scale(1)`, opacity: 1 },
        ],
        { duration: dur, delay: k * 45 * this.speed, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' },
      );
      return a.finished.catch(() => {}).then(() => chip.remove());
    });
    await Promise.all(anims);
  }

  /** Animates an element from a table point to wherever it is laid out now. */
  animateFrom(el, from, { duration = 380, delay = 0, rotate = -60 } = {}) {
    if (reducedMotion()) return Promise.resolve();
    const tableRect = this.el.table.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const dx = from.x - (r.left - tableRect.left + r.width / 2);
    const dy = from.y - (r.top - tableRect.top + r.height / 2);
    const a = el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) rotate(${rotate}deg) scale(0.55)`, opacity: 0, offset: 0 },
        { opacity: 1, offset: 0.3 },
      ],
      { duration: duration * this.speed, delay: delay * this.speed, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'backwards' },
    );
    return a.finished.catch(() => {});
  }

  async animateNumber(el, from, to, duration = 600) {
    const dur = duration * this.speed;
    const start = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const e = 1 - Math.pow(1 - t, 3);
        el.textContent = fmt(from + (to - from) * e);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // ---------------------------------------------------------------- game events

  async onEvent(type, data) {
    switch (type) {
      case 'handStart':
        return this.onHandStart();
      case 'levelUp':
        this.sound.play('levelup');
        this.toast(`Blinds up! ${fmt(data.sb)} / ${fmt(data.bb)}`);
        this.renderTopbar();
        return this.wait(500);
      case 'blinds':
        this.renderAll();
        this.sound.play('chip', { count: 2 });
        return this.wait(250);
      case 'deal':
        return this.onDeal(data.order);
      case 'turn':
        this.setActive(data.player.seat);
        return undefined;
      case 'action':
        return this.onAction(data);
      case 'street':
        return this.onStreet(data);
      case 'collect':
        return this.onCollect(data);
      case 'reveal':
        return this.onReveal(data.players);
      case 'showdown':
        return this.onShowdown(data);
      case 'handEnd':
        return this.onHandEnd(data);
      default:
        return undefined;
    }
  }

  async onHandStart() {
    this.hideMessage();
    this.clearBoard();
    this.oddsToken++;
    this.pre = null;
    this.syncPreactions();
    this.showStreetActions = true;
    this.seatEls.forEach((el) => {
      el.classList.remove('is-winner', 'is-showing', 'is-active', 'is-thinking');
      el.querySelector('.seat__cards').replaceChildren();
      el.querySelector('.seat__hand').textContent = '';
    });
    this.renderAll();
    this.updateHeroInfo();
    const hero = this.hero;
    if (hero?.inHand) this.setControls('waiting');
    else this.setControls('idle', hero?.eliminated ? 'You are out — watching' : '');
    await this.wait(350);
  }

  async onDeal(order) {
    const g = this.game;
    const deck = this.pos.deck;
    for (let round = 0; round < 2; round++) {
      for (const i of order) {
        const p = g.players[i];
        const card = p.isHuman ? cardEl(p.hole[round], { cls: 'card--hero' }) : cardEl(null, { cls: 'card--seat' });
        this.seatEls[i].querySelector('.seat__cards').append(card);
        this.sound.play('deal');
        this.animateFrom(card, deck, { duration: 360 });
        await this.wait(order.length > 4 ? 70 : 95);
      }
    }
    await this.wait(260);
    const hero = this.hero;
    if (hero?.inHand) {
      this.seatEls[hero.seat].querySelectorAll('.card').forEach((c) => c.classList.add('is-faceup'));
      this.sound.play('flip');
    }
    this.updateHeroInfo();
    await this.wait(300);
  }

  async onAction({ player, action }) {
    const i = player.seat;
    this.setThinking(i, false);
    this.setActive(-1);
    this.showStreetActions = true;
    const seatEl = this.seatEls[i];

    if (action.type === 'fold') {
      this.sound.play('fold');
      if (!player.isHuman) {
        const cards = [...seatEl.querySelectorAll('.card')];
        const c = this.pos.center;
        const s = this.pos.seats[i];
        await Promise.all(
          cards.map((card) =>
            card
              .animate(
                [{ opacity: 1 }, { transform: `translate(${(c.x - s.x) * 0.5}px, ${(c.y - s.y) * 0.5}px) rotate(40deg) scale(0.6)`, opacity: 0 }],
                { duration: 320 * this.speed, easing: 'ease-in', fill: 'forwards' },
              )
              .finished.catch(() => {}),
          ),
        );
        cards.forEach((card) => card.remove());
      }
    } else if (action.type === 'check') {
      this.sound.play('check');
    } else {
      this.sound.play(action.allIn ? 'allin' : 'chip', { count: action.type === 'call' ? 2 : 3 });
      this.renderSeat(i);
      await this.flyChips(this.pos.seats[i], this.pos.bets[i], action.amount ?? player.bet, { duration: 300 });
    }
    this.renderSeat(i);
    this.renderBet(i);
    if (player.isHuman && action.type === 'fold') {
      this.setControls('idle', 'You folded');
      this.updateHeroInfo();
    } else if (player.isHuman && action.allIn) {
      this.setControls('idle', 'You are all-in');
    }
    await this.wait(action.type === 'fold' || action.type === 'check' ? 220 : 160);
  }

  async onStreet({ street, board }) {
    const already = this.slots.filter((s) => s.firstChild).length;
    const fresh = board.slice(already);
    const cards = fresh.map((c, k) => {
      const el = cardEl(c);
      this.slots[already + k].append(el);
      this.animateFrom(el, this.pos.deck, { duration: 300, delay: k * 90, rotate: 0 });
      return el;
    });
    this.sound.play('deal');
    await this.wait(300 + fresh.length * 90);
    for (const el of cards) {
      el.classList.add('is-faceup');
      this.sound.play('flip');
      await this.wait(street === 'flop' ? 140 : 80);
    }
    this.updateHeroInfo();
    if (this.game.revealed) this.updateShownHands();
    await this.wait(street === 'flop' ? 380 : 320);
  }

  async onCollect({ refund, hadBets }) {
    const g = this.game;
    if (refund) {
      const i = refund.player.seat;
      this.renderBet(i);
      this.renderSeat(i);
    }
    this.setActive(-1);
    if (hadBets) {
      await this.wait(200);
      const flights = [];
      g.players.forEach((p, i) => {
        if (p.bet > 0) {
          this.betEls[i].classList.add('is-empty');
          flights.push(this.flyChips(this.pos.bets[i], this.pos.pot, p.bet, { duration: 380 }));
        }
      });
      if (flights.length) this.sound.play('chip', { count: 3 });
      await Promise.all(flights);
    }
    this.showStreetActions = false;
    // Engine zeroes bets right after this event; render the pot as it will be.
    this.renderPot(g.totalPot, true);
    g.players.forEach((p, i) => {
      this.betEls[i].classList.add('is-empty');
      this.betEls[i].replaceChildren();
      this.renderSeat(i);
    });
    if (hadBets) await this.wait(180);
  }

  revealSeat(p) {
    const el = this.seatEls[p.seat];
    if (p.isHuman) return;
    el.classList.add('is-showing');
    const cards = [...el.querySelectorAll('.card')];
    p.hole.forEach((c, k) => {
      let card = cards[k];
      if (!card) {
        card = cardEl(c, { cls: 'card--seat' });
        el.querySelector('.seat__cards').append(card);
      } else setCardFace(card, c);
      requestAnimationFrame(() => card.classList.add('is-faceup'));
    });
  }

  updateShownHands() {
    const g = this.game;
    for (const p of g.contenders) {
      const label = this.seatEls[p.seat].querySelector('.seat__hand');
      label.textContent = describePartial([...p.hole, ...g.board]).replace(/^High Card, (\w+)/, '$1 high');
    }
  }

  async onReveal(players) {
    this.message('All in!', 1500);
    for (const p of players) this.revealSeat(p);
    this.sound.play('flip');
    this.updateShownHands();
    this.updateHeroInfo();
    await this.wait(900);
  }

  async onShowdown(result) {
    const g = this.game;
    this.setActive(-1);
    this.oddsToken++;
    this.el.heroOdds.textContent = '';
    const hero = this.hero;
    const heroWon = hero && result.payouts[hero.id] > 0;
    const names = (ids) => ids.map((id) => g.playerById(id).name);

    if (result.uncontested) {
      const pot = result.pots[0];
      const w = g.playerById(pot.winners[0]);
      this.seatEls[w.seat].classList.add('is-winner');
      this.renderSeat(w.seat, { chips: false });
      this.message(`${escapeHtml(w.name)} ${isYou(w) ? 'win' : 'wins'} ${fmt(pot.amount)}`, 2200);
      await this.wait(250);
      this.renderPot(0);
      this.sound.play(w.isHuman ? 'win' : 'chip', { count: 3 });
      await this.flyChips(this.pos.pot, this.pos.seats[w.seat], pot.amount, { duration: 520 });
      await this.addShownChips(w.seat, pot.amount);
      return;
    }

    // Reveal everyone still in, one at a time.
    for (const p of g.contenders) {
      if (!this.seatEls[p.seat].classList.contains('is-showing')) {
        this.revealSeat(p);
        this.sound.play('flip');
        await this.wait(220);
      }
    }
    for (const p of g.contenders) {
      this.seatEls[p.seat].querySelector('.seat__hand').textContent = result.hands[p.id].name;
    }
    await this.wait(500);

    let potLeft = result.pots.reduce((s, p) => s + p.amount, 0);
    const multi = result.pots.length > 1;
    for (let k = 0; k < result.pots.length; k++) {
      const pot = result.pots[k];
      const winners = pot.winners.map((id) => g.playerById(id));
      const hand = result.hands[pot.winners[0]];
      this.highlight(pot.winners.map((id) => result.hands[id].cards).flat());
      winners.forEach((w) => this.seatEls[w.seat].classList.add('is-winner'));
      winners.forEach((w) => this.renderSeat(w.seat, { chips: false }));
      const potName = multi ? (k === 0 ? 'Main pot' : `Side pot ${k}`) : '';
      const who =
        winners.length > 1
          ? `Split pot · ${names(pot.winners).map(escapeHtml).join(' & ')}`
          : `${escapeHtml(winners[0].name)} ${isYou(winners[0]) ? 'win' : 'wins'} ${fmt(pot.amount)}`;
      this.message(`${potName ? `${potName}: ` : ''}${who}<small>${hand.description}</small>`);
      this.sound.play(heroWon && pot.winners.includes(hero.id) ? 'win' : 'chip', { count: 3 });
      potLeft -= pot.amount;
      this.renderPot(potLeft);
      await Promise.all(
        winners.map((w) =>
          this.flyChips(this.pos.pot, this.pos.seats[w.seat], pot.shares[w.id], { duration: 560 }).then(() =>
            this.addShownChips(w.seat, pot.shares[w.id]),
          ),
        ),
      );
      await this.wait(multi ? 1300 : 1500);
      if (k < result.pots.length - 1) {
        winners.forEach((w) => this.seatEls[w.seat].classList.remove('is-winner'));
        this.highlight(null);
      }
    }
    if (hero && hero.inHand && !hero.folded && !heroWon) this.sound.play('lose');
  }

  highlight(cards) {
    const all = this.el.table.querySelectorAll('.card');
    if (!cards) {
      all.forEach((c) => c.classList.remove('is-dim', 'is-highlight'));
      return;
    }
    const set = new Set(cards.map(String));
    all.forEach((c) => {
      const inSet = set.has(c.dataset.card);
      const shown = c.classList.contains('is-faceup');
      c.classList.toggle('is-highlight', inSet && shown);
      c.classList.toggle('is-dim', !inSet && shown);
    });
  }

  async onHandEnd(summary) {
    this.renderPot(0);
    this.renderAll();
    const outs = summary.busted.map((p) => (p.isHuman ? `You finished ${ordinal(p.place)}` : `${p.name} is out (${ordinal(p.place)})`));
    if (outs.length) this.toast(outs.join(' · '), 2600);
  }

  /** Shows the "Next hand" button; resolves when clicked or after the auto-deal delay. */
  waitForNextHand(auto) {
    const btn = this.el.next;
    const bar = this.el.nextProgress;
    this.setControls('idle', '');
    this.el.statusText.hidden = true;
    btn.hidden = false;
    return new Promise((resolve) => {
      let timer;
      let anim;
      const done = () => {
        clearTimeout(timer);
        anim?.cancel();
        btn.removeEventListener('click', done);
        btn.hidden = true;
        this.nextResolver = null;
        resolve();
      };
      this.nextResolver = done;
      btn.addEventListener('click', done);
      if (auto) {
        const ms = 2600 * Math.max(this.speed, 0.5);
        anim = bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: ms, easing: 'linear', fill: 'forwards' });
        timer = setTimeout(done, ms);
      }
    });
  }

  // ---------------------------------------------------------------- player input

  bindControls() {
    const e = this.el;
    e.fold.addEventListener('click', () => this.submit({ type: 'fold' }));
    e.call.addEventListener('click', () => {
      const l = this.pending?.legal;
      if (l) this.submit(l.canCheck ? { type: 'check' } : { type: 'call' });
    });
    e.raise.addEventListener('click', () => this.onRaiseButton());
    e.slider.addEventListener('input', () => this.setRaise(this.sliderToAmount(Number(e.slider.value)), false));
    e.minus.addEventListener('click', () => this.nudgeRaise(-1));
    e.plus.addEventListener('click', () => this.nudgeRaise(1));
    e.preactions.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-pre]');
      if (!b) return;
      this.pre = this.pre === b.dataset.pre ? null : b.dataset.pre;
      this.syncPreactions();
    });
    document.addEventListener('keydown', (ev) => this.onKey(ev));
  }

  syncPreactions() {
    this.el.preactions.querySelectorAll('[data-pre]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pre === this.pre)));
  }

  onKey(ev) {
    if (ev.target.closest?.('input, textarea') || document.querySelector('dialog[open]')) return;
    const l = this.pending?.legal;
    if (!l) return;
    const k = ev.key.toLowerCase();
    if (k === 'f' && !l.canCheck) this.submit({ type: 'fold' });
    else if (k === 'c' || k === 'k') this.submit(l.canCheck ? { type: 'check' } : { type: 'call' });
    else if (k === 'r' || k === 'b') this.onRaiseButton();
    else if (k === 'a' && l.canRaise) this.submit({ type: 'raise', amount: l.maxRaiseTo });
    else if (k === 'enter' && !this.el.raisePanel.hidden) this.onRaiseButton();
    else if (k === 'escape') this.closeRaise();
    else if ((k === 'arrowup' || k === 'arrowright') && !this.el.raisePanel.hidden) this.nudgeRaise(1);
    else if ((k === 'arrowdown' || k === 'arrowleft') && !this.el.raisePanel.hidden) this.nudgeRaise(-1);
    else return;
    ev.preventDefault();
  }

  /** Resolves with the player's action. Pre-selected actions apply immediately when valid. */
  requestAction(player, legal) {
    if (this.pre) {
      const pre = this.pre;
      this.pre = null;
      this.syncPreactions();
      if (pre === 'checkfold') return Promise.resolve(legal.canCheck ? { type: 'check' } : { type: 'fold' });
      if (pre === 'callany') return Promise.resolve(legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, legal, player };
      this.showActions(legal);
      this.sound.play('turn');
      if (this.settings.haptics) navigator.vibrate?.(35);
    });
  }

  cancelPending(reason) {
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      reject(reason);
    }
    this.nextResolver?.();
  }

  submit(action) {
    if (!this.pending) return;
    const { resolve, legal } = this.pending;
    if (action.type === 'fold' && legal.canCheck) action = { type: 'check' };
    this.pending = null;
    this.closeRaise();
    const hero = this.hero;
    if (action.type !== 'fold') this.setControls(hero && hero.inHand ? 'waiting' : 'idle');
    resolve(action);
  }

  showActions(legal) {
    const e = this.el;
    this.setControls('acting');
    e.fold.hidden = legal.canCheck;
    if (legal.canCheck) {
      e.call.innerHTML = 'Check';
    } else if (legal.callIsAllIn) {
      e.call.innerHTML = `Call all-in<small>${fmt(legal.toCall)}</small>`;
    } else {
      e.call.innerHTML = `Call<small>${fmt(legal.toCall)}</small>`;
    }
    e.raise.hidden = !legal.canRaise;
    e.raise.classList.remove('is-confirm');
    if (legal.canRaise) {
      const onlyAllIn = legal.minRaiseTo >= legal.maxRaiseTo;
      e.raise.innerHTML = onlyAllIn
        ? `All-in<small>${fmt(legal.maxRaiseTo)}</small>`
        : `${legal.isBet ? 'Bet' : 'Raise'}<small>…</small>`;
      if (!onlyAllIn) this.prepareRaise(legal);
    }
    const visible = [e.fold, e.call, e.raise].filter((b) => !b.hidden).length;
    e.actions.style.gridTemplateColumns = visible === 3 ? '1fr 1.2fr 1.2fr' : `repeat(${visible}, 1fr)`;
  }

  prepareRaise(legal) {
    const g = this.game;
    const bb = g.bigBlind;
    const unit = chipUnit(bb);
    const potAfterCall = legal.pot + legal.toCall;
    const round = (x) => Math.round(x / unit) * unit;
    const unopened = g.street === 'preflop' && legal.currentBet <= bb && g.raisesThisStreet === 0;
    const presets = unopened
      ? [
          ['2.5x', round(bb * 2.5)],
          ['3x', bb * 3],
          ['4x', bb * 4],
          ['Pot', legal.currentBet + potAfterCall],
          ['All-in', legal.maxRaiseTo],
        ]
      : [
          ['Min', legal.minRaiseTo],
          ['½ Pot', round(legal.currentBet + potAfterCall * 0.5)],
          ['¾ Pot', round(legal.currentBet + potAfterCall * 0.75)],
          ['Pot', legal.currentBet + potAfterCall],
          ['All-in', legal.maxRaiseTo],
        ];
    this.raiseCtx = { legal, unit, presets: presets.map(([l, v]) => [l, clamp(v, legal.minRaiseTo, legal.maxRaiseTo)]) };
    this.el.presets.innerHTML = '';
    for (const [label, value] of this.raiseCtx.presets) {
      const b = document.createElement('button');
      b.className = 'preset';
      b.type = 'button';
      b.textContent = label;
      b.dataset.value = value;
      b.addEventListener('click', () => this.setRaise(value));
      this.el.presets.append(b);
    }
    this.el.slider.min = '0';
    this.el.slider.max = '1000';
    this.el.slider.step = '1';
    const initial = unopened ? this.raiseCtx.presets[0][1] : legal.isBet ? this.raiseCtx.presets[1][1] : legal.minRaiseTo;
    this.setRaise(initial);
    this.el.raise.innerHTML = `${legal.isBet ? 'Bet' : 'Raise'}<small>${fmt(this.raiseTo)}</small>`;
  }

  // Slider maps non-linearly so small bets get fine control even with deep stacks.
  sliderToAmount(pos) {
    const { legal, unit } = this.raiseCtx;
    if (pos >= 1000) return legal.maxRaiseTo;
    if (pos <= 0) return legal.minRaiseTo;
    const raw = legal.minRaiseTo + (legal.maxRaiseTo - legal.minRaiseTo) * Math.pow(pos / 1000, 1.8);
    return clamp(Math.round(raw / unit) * unit, legal.minRaiseTo, legal.maxRaiseTo);
  }

  amountToSlider(amount) {
    const { legal } = this.raiseCtx;
    const span = legal.maxRaiseTo - legal.minRaiseTo;
    if (span <= 0) return 1000;
    return Math.round(Math.pow((amount - legal.minRaiseTo) / span, 1 / 1.8) * 1000);
  }

  setRaise(amount, syncSlider = true) {
    const { legal } = this.raiseCtx;
    this.raiseTo = clamp(Math.round(amount), legal.minRaiseTo, legal.maxRaiseTo);
    const pos = syncSlider ? this.amountToSlider(this.raiseTo) : Number(this.el.slider.value);
    if (syncSlider) this.el.slider.value = String(pos);
    this.el.slider.style.setProperty('--fill', `${pos / 10}%`);
    const allIn = this.raiseTo >= legal.maxRaiseTo;
    this.el.amount.textContent = allIn ? 'ALL-IN' : fmt(this.raiseTo);
    this.el.presets.querySelectorAll('.preset').forEach((b) => b.classList.toggle('is-current', Number(b.dataset.value) === this.raiseTo));
    if (!this.el.raisePanel.hidden) {
      const verb = allIn ? 'All-in' : legal.isBet ? 'Bet' : 'Raise to';
      this.el.raise.innerHTML = `${verb}<small>${fmt(this.raiseTo)}</small>`;
    }
  }

  nudgeRaise(dir) {
    if (!this.raiseCtx) return;
    const step = Math.max(this.raiseCtx.unit, this.game.bigBlind);
    const base = Math.round(this.raiseTo / step) * step;
    this.setRaise(dir > 0 ? Math.max(base + step, this.raiseTo + 1) : Math.min(base - step, this.raiseTo - 1));
  }

  onRaiseButton() {
    const l = this.pending?.legal;
    if (!l || !l.canRaise) return;
    if (l.minRaiseTo >= l.maxRaiseTo) {
      this.submit({ type: 'raise', amount: l.maxRaiseTo });
      return;
    }
    if (this.el.raisePanel.hidden) {
      this.el.raisePanel.hidden = false;
      this.el.raise.classList.add('is-confirm');
      this.setRaise(this.raiseTo);
      return;
    }
    this.submit({ type: 'raise', amount: this.raiseTo });
  }

  closeRaise() {
    this.el.raisePanel.hidden = true;
    this.el.raise.classList.remove('is-confirm');
  }

  // ---------------------------------------------------------------- static content

  renderRankings(list) {
    const examples = [
      ['Royal Flush', 'Ah Kh Qh Jh Th', 'A, K, Q, J, 10 — all one suit', 5],
      ['Straight Flush', '9s 8s 7s 6s 5s', 'Five in a row, one suit', 5],
      ['Four of a Kind', 'Qc Qd Qh Qs 7d', 'Four cards of one rank', 4],
      ['Full House', 'Kh Kd Ks 4c 4h', 'Three of a kind plus a pair', 5],
      ['Flush', 'Ad Jd 8d 6d 2d', 'Any five of one suit', 5],
      ['Straight', 'Tc 9d 8s 7h 6c', 'Five in a row, mixed suits', 5],
      ['Three of a Kind', '7s 7h 7d Kc 2s', 'Three cards of one rank', 3],
      ['Two Pair', 'Jc Jh 5d 5s Ac', 'Two different pairs', 4],
      ['One Pair', 'Ts Td Ac 8h 4d', 'Two cards of one rank', 2],
      ['High Card', 'Ah Jc 9d 6s 3h', 'Nothing else — highest card plays', 1],
    ];
    list.innerHTML = '';
    examples.forEach(([name, cards, blurb, used], k) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rankings__n">${k + 1}</span><span class="rankings__name">${name}<small>${blurb}</small></span>`;
      const row = document.createElement('div');
      row.className = 'rankings__cards';
      parseCards(cards).forEach((c, i) => {
        const el = cardEl(c, { faceUp: true });
        if (i >= used) el.classList.add('is-dim');
        row.append(el);
      });
      li.append(row);
      list.append(li);
    });
  }
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

