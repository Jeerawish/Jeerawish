// App controller: lobby, game loop, dialogs, persistence.

import { PokerGame, BLIND_LEVELS } from './engine.js';
import { decide, BOT_ROSTER, STYLES } from './ai.js';
import { TableUI, StaleTable, cardEl, cardText, fmt, ordinal, escapeHtml, isYou } from './ui.js';
import { Sound } from './sound.js';
import { shuffle, parseCards, secureRandomInt } from './cards.js';
import * as store from './storage.js';

const DEFAULT_SETTINGS = { speed: 'normal', sound: true, haptics: true, showOdds: true, fourColor: false, autoDeal: true };
const DEFAULT_SETUP = { name: '', opponents: 5, difficulty: 'normal', stack: 2000, blindSpeed: 10 };
const DEFAULT_STATS = {
  handsPlayed: 0,
  handsWon: 0,
  showdownsWon: 0,
  biggestPot: 0,
  bestHandScore: -1,
  bestHand: '',
  tournaments: 0,
  wins: 0,
  bestFinish: 0,
};

const settings = store.load('settings', DEFAULT_SETTINGS);
const setup = store.load('setup', DEFAULT_SETUP);
const stats = store.load('stats', DEFAULT_STATS);

const sound = new Sound();
sound.enabled = settings.sound;
const ui = new TableUI({ settings, sound });
const $ = (id) => document.getElementById(id);

class Aborted extends Error {}

let session = null;

// ------------------------------------------------------------------ pause gate

const openDialogs = new Set();
const gate = {
  waiters: [],
  get paused() {
    return openDialogs.size > 0 || document.hidden;
  },
  async wait() {
    while (this.paused) await new Promise((r) => this.waiters.push(r));
  },
  release() {
    if (this.paused) return;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((r) => r());
  },
};
document.addEventListener('visibilitychange', () => {
  gate.release();
  if (!document.hidden && session) requestWakeLock();
});

function check(s) {
  if (s.aborted) throw new Aborted();
}

// ------------------------------------------------------------------ hand history

const STREET_NAMES = { flop: 'Flop', turn: 'Turn', river: 'River' };

class HandLog {
  constructor() {
    this.hands = [];
    this.cur = null;
  }

  line(html, cls = '') {
    this.cur?.lines.push({ html, cls });
  }

  onEvent(type, d, g) {
    const name = (p) => `<b>${escapeHtml(p.name)}</b>`;
    // "Ava raises" but "You raise".
    const v = (p, third, second) => (isYou(p) ? second : third);
    switch (type) {
      case 'handStart':
        this.cur = { n: d.handNumber, blinds: `${fmt(d.sb)}/${fmt(d.bb)}`, lines: [] };
        this.hands.unshift(this.cur);
        if (this.hands.length > 40) this.hands.pop();
        this.line(`${name(g.players[d.dealerIndex])} ${v(g.players[d.dealerIndex], 'has', 'have')} the button`);
        break;
      case 'blinds':
        this.line(`${name(d.sb.player)} ${v(d.sb.player, 'posts', 'post')} small blind ${fmt(d.sb.amount)}`);
        this.line(`${name(d.bb.player)} ${v(d.bb.player, 'posts', 'post')} big blind ${fmt(d.bb.amount)}`);
        break;
      case 'deal': {
        const hero = g.players.find((p) => p.isHuman && p.inHand);
        if (hero) this.line(`Dealt to ${name(hero)}: ${hero.hole.map(cardText).join(' ')}`);
        break;
      }
      case 'action': {
        const a = d.action;
        const p = d.player;
        const verb = {
          fold: v(p, 'folds', 'fold'),
          check: v(p, 'checks', 'check'),
          call: `${v(p, 'calls', 'call')} ${fmt(a.amount ?? 0)}`,
          bet: `${v(p, 'bets', 'bet')} ${fmt(a.amount ?? 0)}`,
          raise: `${v(p, 'raises', 'raise')} to ${fmt(a.amount ?? 0)}`,
        }[a.type];
        this.line(`${name(p)} ${verb}${a.allIn ? ` and ${v(p, 'is', 'are')} all-in` : ''}`);
        break;
      }
      case 'street':
        this.line(`${STREET_NAMES[d.street]}: ${d.board.map(cardText).join(' ')}`, 'street');
        break;
      case 'collect':
        if (d.refund) this.line(`Uncalled ${fmt(d.refund.amount)} returned to ${name(d.refund.player)}`);
        break;
      case 'showdown':
        if (!d.uncontested) {
          this.line('Showdown', 'street');
          for (const [id, h] of Object.entries(d.hands)) {
            const p = g.playerById(id);
            this.line(`${name(p)} ${v(p, 'shows', 'show')} ${p.hole.map(cardText).join(' ')} — ${h.description}`);
          }
        }
        d.pots.forEach((pot, k) => {
          const label = d.pots.length > 1 ? (k === 0 ? ' from the main pot' : ` from side pot ${k}`) : '';
          for (const id of pot.winners) {
            const p = g.playerById(id);
            this.line(`${name(p)} ${v(p, 'wins', 'win')} ${fmt(pot.shares[id])}${label}`, 'win');
          }
        });
        break;
      case 'handEnd':
        for (const p of d.busted) this.line(`${name(p)} ${v(p, 'is', 'are')} eliminated (${ordinal(p.place)})`);
        break;
      default:
    }
  }
}

// ------------------------------------------------------------------ game lifecycle

function makeHooks(s) {
  return {
    getAction: async (p, legal, game) => {
      check(s);
      if (p.isHuman) {
        const action = await ui.requestAction(p, legal);
        check(s);
        return action;
      }
      ui.setThinking(p.seat, true);
      const big = legal.toCall > game.bigBlind * 4 || game.street === 'river';
      await ui.wait(380 + Math.random() * 620 + (big ? 380 : 0));
      await gate.wait();
      check(s);
      try {
        return decide(p, legal, game, s.config.difficulty);
      } catch (err) {
        console.error(err);
        return legal.canCheck ? { type: 'check' } : { type: 'fold' };
      }
    },
    emit: async (type, data, game) => {
      check(s);
      s.log.onEvent(type, data, game);
      await ui.onEvent(type, data);
      await gate.wait();
      check(s);
    },
  };
}

function createGame(config) {
  const bots = shuffle(BOT_ROSTER.slice()).slice(0, config.opponents);
  const players = [
    { id: 'hero', name: config.name || 'You', chips: config.stack, isHuman: true, avatar: '🙂' },
    ...bots.map((b, i) => ({ id: `bot${i}`, name: b.name, avatar: b.avatar, style: b.style, chips: config.stack })),
  ];
  return new PokerGame({
    players,
    blindLevels: BLIND_LEVELS,
    handsPerLevel: config.blindSpeed,
    dealerIndex: secureRandomInt(players.length),
  });
}

function restoreGame(saved) {
  const st = saved.state;
  return new PokerGame({
    players: st.players,
    blindLevels: BLIND_LEVELS,
    handsPerLevel: st.handsPerLevel,
    levelIndex: st.levelIndex,
    handNumber: st.handNumber,
    dealerIndex: st.dealerIndex,
  });
}

function startGame(config, saved = null) {
  endSession();
  const game = saved ? restoreGame(saved) : createGame(config);
  const s = {
    game,
    config,
    aborted: false,
    log: new HandLog(),
    stats: saved?.sessionStats ?? { hands: 0, won: 0, biggestPot: 0, bestHandScore: -1, bestHand: '' },
  };
  session = s;
  game.hooks = makeHooks(s);
  showScreen('game');
  ui.setup(game);
  requestWakeLock();
  if (!saved) persist(s);
  runLoop(s);
}

function endSession() {
  if (!session) return;
  session.aborted = true;
  ui.cancelPending(new Aborted());
  gate.release();
  session = null;
  releaseWakeLock();
}

const heroOf = (game) => game.players.find((p) => p.isHuman);

async function runLoop(s) {
  const { game } = s;
  try {
    while (!game.isOver && !heroOf(game).eliminated) {
      await gate.wait();
      check(s);
      const summary = await game.playHand();
      recordHand(s, summary);
      if (game.isOver || heroOf(game).eliminated) break;
      persist(s);
      await gate.wait();
      check(s);
      await ui.waitForNextHand(settings.autoDeal);
      check(s);
    }
    finishTournament(s);
  } catch (err) {
    if (err instanceof Aborted || err instanceof StaleTable || s.aborted) return;
    console.error(err);
    if (session === s) {
      ui.toast('Oops — re-dealing the hand');
      const saved = store.load('game');
      if (saved) startGame(saved.config, saved);
      else showScreen('lobby');
    }
  }
}

function persist(s) {
  store.save('game', { config: s.config, state: s.game.toJSON(), sessionStats: s.stats, savedAt: Date.now() });
}

function recordHand(s, summary) {
  const hero = heroOf(s.game);
  if (!hero.inHand) return;
  const { result } = summary;
  const won = result.payouts[hero.id] || 0;
  stats.handsPlayed++;
  s.stats.hands++;
  if (won > 0) {
    stats.handsWon++;
    s.stats.won++;
    stats.biggestPot = Math.max(stats.biggestPot, won);
    s.stats.biggestPot = Math.max(s.stats.biggestPot, won);
    if (!result.uncontested) stats.showdownsWon++;
  }
  const h = result.hands[hero.id];
  if (h) {
    if (h.score > stats.bestHandScore) {
      stats.bestHandScore = h.score;
      stats.bestHand = h.description;
    }
    if (h.score > s.stats.bestHandScore) {
      s.stats.bestHandScore = h.score;
      s.stats.bestHand = h.description;
    }
  }
  store.save('stats', stats);
}

function finishTournament(s) {
  const { game } = s;
  const hero = heroOf(game);
  store.remove('game');
  stats.tournaments++;
  const place = hero.place ?? 1;
  if (place === 1) stats.wins++;
  stats.bestFinish = stats.bestFinish ? Math.min(stats.bestFinish, place) : place;
  store.save('stats', stats);
  refreshContinue();

  const n = game.players.length;
  const icon = place === 1 ? '🏆' : place === 2 ? '🥈' : place === 3 ? '🥉' : '🃏';
  $('gameover-icon').textContent = icon;
  $('gameover-title').textContent = place === 1 ? 'Champion!' : `You finished ${ordinal(place)}`;
  $('gameover-text').textContent =
    place === 1
      ? `You beat ${n - 1} opponent${n > 2 ? 's' : ''} in ${game.handNumber} hands.`
      : `Out of ${n} players, on hand ${game.handNumber}. Shuffle up and try again!`;
  $('gameover-stats').innerHTML = statTiles([
    ['Hands played', fmt(s.stats.hands)],
    ['Hands won', fmt(s.stats.won)],
    ['Biggest pot', fmt(s.stats.biggestPot)],
    ['Finish', `${ordinal(place)} / ${n}`],
    ['Best hand', s.stats.bestHand || '—', true],
  ]);
  setTimeout(() => {
    if (session !== s) return;
    openDialog($('dlg-gameover'));
    if (place === 1) {
      sound.play('win');
      confetti();
    }
  }, 900);
}

// ------------------------------------------------------------------ screens & dialogs

function showScreen(name) {
  $('lobby').hidden = name !== 'lobby';
  $('game').hidden = name !== 'game';
  if (name === 'lobby') refreshContinue();
  if (name === 'game') requestAnimationFrame(() => ui.layout());
}

function openDialog(dlg) {
  if (dlg.open) return;
  dlg.showModal();
  openDialogs.add(dlg);
  if (dlg.id === 'dlg-stats') renderStats();
  if (dlg.id === 'dlg-history') renderHistory();
}

document.querySelectorAll('dialog').forEach((dlg) => {
  dlg.addEventListener('close', () => {
    openDialogs.delete(dlg);
    gate.release();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && dlg.id !== 'dlg-gameover' && dlg.id !== 'dlg-confirm') dlg.close();
  });
  if (dlg.id === 'dlg-gameover') dlg.addEventListener('cancel', (e) => e.preventDefault());
});

document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open]');
  if (opener) openDialog($(opener.dataset.open));
  const closer = e.target.closest('[data-close]');
  if (closer) closer.closest('dialog')?.close();
});

function confirmDialog(title, text, yes = 'Yes') {
  const dlg = $('dlg-confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = yes;
  openDialog(dlg);
  return new Promise((resolve) => {
    const finish = (v) => {
      $('confirm-yes').onclick = null;
      $('confirm-no').onclick = null;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    $('confirm-yes').onclick = () => finish(true);
    $('confirm-no').onclick = () => finish(false);
    dlg.onclose = () => finish(false);
  });
}

function statTiles(items) {
  return items
    .map(
      ([label, value, wide]) =>
        `<div class="stat${wide ? ' stat--wide' : ''}"><div class="stat__value">${escapeHtml(value)}</div><div class="stat__label">${label}</div></div>`,
    )
    .join('');
}

function renderStats() {
  const pct = stats.handsPlayed ? `${Math.round((stats.handsWon / stats.handsPlayed) * 100)}%` : '—';
  $('stats-grid').innerHTML = statTiles([
    ['Tournaments', fmt(stats.tournaments)],
    ['Wins', fmt(stats.wins)],
    ['Hands played', fmt(stats.handsPlayed)],
    ['Hands won', pct],
    ['Showdowns won', fmt(stats.showdownsWon)],
    ['Best finish', stats.bestFinish ? ordinal(stats.bestFinish) : '—'],
    ['Biggest pot', fmt(stats.biggestPot)],
    ['Best hand', stats.bestHand || '—', true],
  ]);
}

function renderHistory() {
  const box = $('history');
  const hands = session?.log.hands ?? [];
  if (!hands.length) {
    box.innerHTML = '<p class="empty-note">No hands played yet.</p>';
    return;
  }
  box.innerHTML = hands
    .map(
      (h) => `<section class="history__hand">
        <div class="history__title"><span>Hand #${h.n}</span><span>Blinds ${h.blinds}</span></div>
        <ul class="history__lines">${h.lines.map((l) => `<li class="${l.cls}">${l.html}</li>`).join('')}</ul>
      </section>`,
    )
    .join('');
}

// ------------------------------------------------------------------ segmented controls & switches

function bindSegmented(group, target, key, onChange) {
  const sync = () => {
    group.querySelectorAll('[role=radio]').forEach((b) => {
      const on = String(target[key]) === b.dataset.value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[role=radio]');
    if (!b) return;
    const v = b.dataset.value;
    target[key] = /^\d+$/.test(v) ? Number(v) : v;
    sync();
    onChange?.();
  });
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const buttons = [...group.querySelectorAll('[role=radio]')];
    const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
    next.click();
    next.focus();
    e.preventDefault();
  });
  sync();
}

function applySettings() {
  sound.enabled = settings.sound;
  document.body.classList.toggle('four-color', settings.fourColor);
  $('btn-sound').setAttribute('aria-pressed', String(settings.sound));
  document.querySelectorAll('[data-toggle]').forEach((sw) => sw.setAttribute('aria-checked', String(!!settings[sw.dataset.toggle])));
  store.save('settings', settings);
}

document.querySelectorAll('#setup-form [data-setting]').forEach((g) =>
  bindSegmented(g, setup, g.dataset.setting, () => {
    store.save('setup', setup);
    updateHints();
  }),
);
document.querySelectorAll('#dlg-settings [data-setting]').forEach((g) => bindSegmented(g, settings, g.dataset.setting, applySettings));
document.querySelectorAll('[data-toggle]').forEach((sw) =>
  sw.addEventListener('click', () => {
    const key = sw.dataset.toggle;
    settings[key] = !settings[key];
    applySettings();
    if (key === 'showOdds') ui.updateHeroInfo();
    if (key === 'sound' && settings.sound) {
      sound.unlock();
      sound.play('chip');
    }
  }),
);

function updateHints() {
  $('stack-hint').textContent = `${fmt(setup.stack)} chips`;
  $('blinds-hint').textContent = setup.blindSpeed ? `every ${setup.blindSpeed} hands` : 'fixed 10/20';
}

// ------------------------------------------------------------------ lobby

function buildFan() {
  const fan = $('brand-fan');
  parseCards('Th Jh Qh Kh Ah').forEach((c, i) => {
    const el = cardEl(c, { faceUp: true });
    el.style.transform = `translateX(${(i - 2) * 30}px) translateY(${Math.abs(i - 2) * 6}px) rotate(${(i - 2) * 9}deg)`;
    el.style.zIndex = String(i);
    fan.append(el);
  });
}

function refreshContinue() {
  const saved = store.load('game');
  const ok = !!(saved && saved.state && saved.state.players);
  $('continue-wrap').hidden = !ok;
  if (ok) {
    const left = saved.state.players.filter((p) => !p.eliminated).length;
    $('continue-info').textContent = `· hand ${saved.state.handNumber + 1} · ${left} left`;
  }
}

$('player-name').value = setup.name;
$('player-name').addEventListener('input', (e) => {
  setup.name = e.target.value.trim().slice(0, 14);
  store.save('setup', setup);
});
$('setup-form').addEventListener('submit', (e) => e.preventDefault());

$('btn-start').addEventListener('click', async () => {
  sound.unlock();
  const saved = store.load('game');
  if (saved && !(await confirmDialog('Start a new game?', 'Your unfinished tournament will be discarded.', 'New game'))) return;
  store.remove('game');
  startGame({ ...setup });
});

$('btn-continue').addEventListener('click', () => {
  sound.unlock();
  const saved = store.load('game');
  if (saved) startGame(saved.config, saved);
});

// ------------------------------------------------------------------ in-game buttons

$('btn-menu').addEventListener('click', () => openDialog($('dlg-menu')));
$('btn-history').addEventListener('click', () => openDialog($('dlg-history')));
$('btn-sound').addEventListener('click', () => {
  settings.sound = !settings.sound;
  applySettings();
  if (settings.sound) {
    sound.unlock();
    sound.play('chip');
  }
});

$('btn-lobby').addEventListener('click', () => {
  $('dlg-menu').close();
  endSession();
  showScreen('lobby');
});

$('btn-restart').addEventListener('click', async () => {
  const config = session?.config;
  if (!config) return;
  $('dlg-menu').close();
  if (!(await confirmDialog('Restart tournament?', 'Everyone goes back to a fresh stack.', 'Restart'))) return;
  store.remove('game');
  startGame({ ...config });
});

$('btn-again').addEventListener('click', () => {
  const config = session?.config ?? setup;
  $('dlg-gameover').close();
  startGame({ ...config });
});

$('btn-gameover-lobby').addEventListener('click', () => {
  $('dlg-gameover').close();
  endSession();
  showScreen('lobby');
});

$('btn-reset-stats').addEventListener('click', async () => {
  if (!(await confirmDialog('Reset statistics?', 'This clears your lifetime stats.', 'Reset'))) return;
  Object.assign(stats, DEFAULT_STATS);
  store.save('stats', stats);
  renderStats();
});

document.addEventListener('pointerdown', () => sound.unlock(), { passive: true });

// ------------------------------------------------------------------ extras

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function confetti() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  };
  resize();
  const colors = ['#f6cd61', '#ff6b6b', '#4dabf7', '#51cf66', '#cc5de8', '#ffffff'];
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.6,
    vx: (Math.random() - 0.5) * 3 * dpr,
    vy: (2 + Math.random() * 4) * dpr,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    w: (6 + Math.random() * 6) * dpr,
    h: (8 + Math.random() * 8) * dpr,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  const frame = (now) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.04 * dpr;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (now - start < 4500) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot

buildFan();
ui.renderRankings($('rankings'));
applySettings();
updateHints();
showScreen('lobby');

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Exposed for debugging in the console.
window.holdem = { get session() { return session; }, STYLES };
