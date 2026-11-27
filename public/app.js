import { parseAddress, rackOf, slotMatches, compareCodes, statusKey, classifyScan, normalizeCode, replaceLocation } from './locations.js';

// ---------- settings ----------
const OUT_TOO_LONG_MIN = 120; // "Out now" turns red after this many minutes
const SCAN_MEMORY_MS = 3 * 60_000; // forget a half-finished scan pair after 3 minutes
const REFRESH_MS = 90_000;

// ---------- state ----------
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const S = {
  worker: store.get('qr.worker'),
  pin: store.get('qr.pin'),
  pinRequired: false,
  pilot: null, // Set of rack codes when PILOT_RACKS is set, otherwise null
  allSkus: new Set(),
  mock: false,
  materials: new Map(), // sku -> { sku, name, address, locs: [{code,label,note}] }
  codes: new Map(), // location code -> { label, skus: Set }
  racks: new Set(),
  skus: new Set(),
  status: new Map(), // "sku|code" -> { status: "OUT"|"IN", by, at, iso, ... }
  loadedAt: 0,
  loading: null,
  today: null,
  todayAt: 0,
  todayFilter: 'todo',
  route: { name: 'home' },
  search: '',
  scanOpen: false,
  ctx: { slot: null, bottle: null, target: null, goTo: null },
  busy: false,
  lastScan: { text: '', at: 0 },
  sheetHandlers: [],
  sheetTimer: null,
  qr: null,
  camOn: false,
  audio: null,
};

const $ = (id) => document.getElementById(id);
const view = $('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- saved on the phone ----------
// The last copy of the sheet and every scan not yet sent live in the phone's storage,
// so the app keeps working with no connection and nothing is lost if it's closed.
const KEYS = { data: 'qr.cache.data', today: 'qr.cache.today', outbox: 'qr.outbox', failed: 'qr.failed', pinRequired: 'qr.pinRequired', demo: 'qr.demo', demoOps: 'qr.demoOps' };
const saved = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
S.snapshot = saved.get(KEYS.data, null); // last data from the server: { materials, status, pilotRacks, savedAt }
S.outbox = saved.get(KEYS.outbox, []); // scans waiting to be sent, oldest first
S.failed = saved.get(KEYS.failed, []); // scans the server refused (shown to the user)
S.online = navigator.onLine !== false;
S.demo = saved.get(KEYS.demo, false); // demo: nothing is sent anywhere, scans live on this phone only
S.demoOps = saved.get(KEYS.demoOps, []);

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// ---------- server ----------
async function apiFetch(path, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { ...opts, signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'x-app-pin': S.pin, ...(opts.headers || {}) } });
  } catch {
    const err = new Error('No connection. Check Wi-Fi or mobile data.');
    err.offline = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    S.pin = '';
    store.set('qr.pin', '');
    const err = new Error('Wrong or missing PIN');
    err.pin = true;
    throw err;
  }
  if (!res.ok || data === null) {
    const err = new Error(data?.error || `Something went wrong (${res.status})`);
    err.status = res.status;
    // Google hiccups, timeouts, Wi-Fi login pages: try again later
    err.transient = res.status >= 500 || res.status === 408 || res.status === 429 || data === null;
    throw err;
  }
  return data;
}

function setOnline(on) {
  if (S.online === on) return;
  S.online = on;
  renderSync();
  if (on) flush();
}

// In pilot mode only materials with a location on a pilot rack are used.
const inUse = (m) => Boolean(m) && (!S.pilot || m.locs.length > 0);
const pilotText = () => (S.pilot ? [...S.pilot].sort(compareCodes).join(', ') : '');

function indexMaterials() {
  S.codes = new Map();
  S.racks = new Set(S.pilot || []);
  S.skus = new Set();
  S.allSkus = new Set();
  for (const m of S.materials.values()) {
    S.allSkus.add(m.sku);
    if (!inUse(m)) continue;
    S.skus.add(m.sku);
    for (const l of m.locs) {
      if (!S.codes.has(l.code)) S.codes.set(l.code, { label: l.label, skus: new Set() });
      S.codes.get(l.code).skus.add(m.sku);
      S.racks.add(rackOf(l.code));
    }
  }
}

function setMaterial({ sku, name, address }) {
  const all = parseAddress(address);
  const onPilot = (l) => !S.pilot || S.pilot.has(rackOf(l.code));
  S.materials.set(sku, { sku, name, address, locs: all.filter(onPilot), otherLocs: all.filter((l) => !onPilot(l)) });
}

/** What the phone shows = last server copy + every scan still waiting to be sent. */
function rebuild() {
  const d = S.snapshot;
  if (!d) return;
  S.pilot = d.pilotRacks?.length ? new Set(d.pilotRacks) : null;
  S.materials = new Map();
  d.materials.forEach(setMaterial);
  S.status = new Map(d.status.map((s) => [s.key, s]));
  if (S.demo) S.demoOps.forEach((op) => applyLocal(op, false));
  S.outbox.forEach((op) => applyLocal(op, true));
  indexMaterials();
}

function applyLocal(op, pending = true) {
  const m = S.materials.get(op.sku);
  if (!m) return;
  const mark = (code, status) => {
    const key = statusKey(op.sku, code);
    S.status.set(key, { key, sku: op.sku, material: m.name, code, status, by: op.worker, at: op.at, iso: op.iso, pending });
  };
  if (op.action === 'take' || op.action === 'return') return mark(op.code, op.action === 'take' ? 'OUT' : 'IN');
  if (op.action === 'move') {
    const toCode = normalizeCode(op.toLabel);
    const codes = parseAddress(m.address).map((l) => l.code);
    const alreadyDone = op.fromCode ? !codes.includes(op.fromCode) && codes.includes(toCode) : codes.includes(toCode);
    if (!alreadyDone) setMaterial({ sku: m.sku, name: m.name, address: replaceLocation(m.address, op.fromCode || '', op.toLabel) });
    if (op.fromCode && op.fromCode !== toCode) S.status.delete(statusKey(op.sku, op.fromCode));
    mark(toCode, 'IN');
  }
}

function saveSnapshot(d) {
  S.snapshot = { pilotRacks: d.pilotRacks || [], materials: d.materials, status: d.status, savedAt: Date.now() };
  saved.set(KEYS.data, S.snapshot);
}

/** Fold the server's answer to one scan into the saved copy. */
function patchSnapshot(d) {
  if (!S.snapshot) return;
  const gone = new Set([...(d.removedKeys || []), ...(d.status || []).map((s) => s.key)]);
  S.snapshot.status = S.snapshot.status.filter((s) => !gone.has(s.key)).concat(d.status || []);
  if (d.material) {
    const m = S.snapshot.materials.find((x) => x.sku === d.material.sku);
    if (m) m.address = d.material.address;
  }
  saved.set(KEYS.data, S.snapshot);
}

function loadData() {
  if (S.loading) return S.loading;
  S.loading = (async () => {
    try {
      const d = await apiFetch('/api/data');
      setOnline(true);
      saveSnapshot(d);
      rebuild();
    } catch (e) {
      if ((e.offline || e.transient) && S.snapshot) {
        if (e.offline) setOnline(false);
        rebuild(); // keep working from the saved copy
      } else throw e;
    } finally {
      S.loadedAt = Date.now();
      S.loading = null;
    }
  })();
  return S.loading;
}

async function loadToday(force = false) {
  if (!force && S.today && Date.now() - S.todayAt < 60_000) return S.today;
  try {
    S.today = { ...(await apiFetch('/api/today')), savedAt: Date.now() };
    saved.set(KEYS.today, S.today);
  } catch (e) {
    const copy = saved.get(KEYS.today, null);
    if (!((e.offline || e.transient) && copy)) throw e;
    if (e.offline) setOnline(false);
    S.today = copy;
  }
  S.todayAt = Date.now();
  return S.today;
}

// ---------- sending saved scans ----------
const saveQueue = () => {
  saved.set(KEYS.outbox, S.outbox);
  saved.set(KEYS.failed, S.failed);
  renderSync();
};

const opBody = (op) => ({
  action: op.action, sku: op.sku, code: op.code, fromCode: op.fromCode, toLabel: op.toLabel, note: op.note,
  worker: op.worker, at: op.at, iso: op.iso, opId: op.id,
});

let flushing = null;
/** Send waiting scans one by one, oldest first. Stops at the first connection problem. */
function flush() {
  if (flushing) return flushing;
  if (!S.outbox.length) return Promise.resolve(new Map());
  flushing = (async () => {
    const results = new Map();
    try {
      while (S.outbox.length) {
        const op = S.outbox[0];
        renderSync();
        try {
          const d = await apiFetch('/api/action', { method: 'POST', body: JSON.stringify(opBody(op)) }, 20000);
          S.outbox.shift();
          patchSnapshot(d);
          saveQueue();
          if (!S.online) setOnline(true);
          results.set(op.id, { ok: true, d });
        } catch (e) {
          if (e.offline) {
            setOnline(false);
            results.set(op.id, { queued: true });
            break;
          }
          if (e.transient || e.pin) {
            results.set(op.id, e.pin ? { pin: true } : { queued: true });
            break;
          }
          // The server refused it (e.g. the location changed meanwhile): keep it aside for a person to see.
          S.outbox.shift();
          S.failed.push({ ...op, error: e.message, failedAt: new Date().toISOString() });
          saveQueue();
          results.set(op.id, { failed: true, error: e.message });
        }
      }
    } finally {
      flushing = null;
      rebuild();
      renderSync();
      refreshView();
    }
    return results;
  })();
  return flushing;
}

// ---------- helpers ----------
const statusOf = (sku, code) => S.status.get(statusKey(sku, code)) || null;
const isOut = (sku, code) => statusOf(sku, code)?.status === 'OUT';
const codeLabel = (code) => S.codes.get(code)?.label || code;

function minutesSince(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
}
function ago(iso) {
  const m = minutesSince(iso);
  if (m === null) return '';
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} days`;
}
function isToday(iso) {
  const t = new Date(iso);
  const n = new Date();
  return !Number.isNaN(t.getTime()) && t.toDateString() === n.toDateString();
}
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function outList() {
  return [...S.status.values()]
    .filter((s) => s.status === 'OUT')
    .sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
}
function locChip(sku, loc) {
  const st = statusOf(sku, loc.code);
  const out = st?.status === 'OUT';
  return `<span class="chip ${out ? 'out' : ''}" title="${out ? 'Out' : 'In place'}">${esc(loc.label)}${out ? ' · out' : ''}</span>`;
}
function materialState(sku) {
  const m = S.materials.get(sku);
  const entries = (m?.locs || []).map((l) => statusOf(sku, l.code)).filter(Boolean);
  if (entries.some((e) => e.status === 'OUT')) return 'out';
  if (entries.some((e) => e.status === 'IN' && isToday(e.iso))) return 'done';
  return 'todo';
}

// ---------- feedback ----------
function beep(kind) {
  try {
    S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = S.audio;
    if (ctx.state === 'suspended') ctx.resume();
    if (kind === 'unlock') return;
    const tones = { ok: [880], done: [880, 1320], bad: [220, 180] }[kind] || [660];
    tones.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.18, ctx.currentTime + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.11);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.12);
      o.stop(ctx.currentTime + i * 0.12 + 0.12);
    });
  } catch { /* no audio */ }
  try { navigator.vibrate?.(kind === 'bad' ? [80, 60, 80] : kind === 'done' ? [40, 40, 80] : 40); } catch { /* ignore */ }
}

function showSheet({ tone = 'info', title, body = '', buttons = [], autoClose = 0 }) {
  clearTimeout(S.sheetTimer);
  S.sheetHandlers = buttons.map((b) => b.onClick || (() => hideSheet()));
  const sheet = $('sheet');
  sheet.className = `sheet ${tone}`;
  sheet.innerHTML = `
    <div class="sheet-card">
      <div class="sheet-title">${title}</div>
      ${body ? `<div class="sheet-body">${body}</div>` : ''}
      <div class="sheet-buttons">
        ${buttons.map((b, i) => `<button class="big ${b.style || (i === 0 ? 'primary' : 'ghost')}" data-act="sheetBtn" data-i="${i}">${b.label}</button>`).join('')}
      </div>
    </div>`;
  sheet.hidden = false;
  if (autoClose) S.sheetTimer = setTimeout(hideSheet, autoClose);
}
function hideSheet() {
  clearTimeout(S.sheetTimer);
  $('sheet').hidden = true;
  $('sheet').innerHTML = '';
  S.sheetHandlers = [];
  if (S.scanOpen) updateScanStep();
}
const sheetOpen = () => !$('sheet').hidden;

// ---------- navigation ----------
function go(name, params = {}, replace = false) {
  S.route = { name, ...params };
  const state = { route: S.route };
  if (replace) history.replaceState(state, '');
  else history.pushState(state, '');
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', (e) => {
  if (S.scanOpen) {
    closeScanner({ fromHistory: true });
    return;
  }
  if (sheetOpen()) hideSheet();
  S.route = e.state?.route || { name: 'home' };
  render();
});

// ---------- views ----------
function render() {
  $('whoBtn').textContent = S.worker ? `${S.worker} ▾` : '';
  $('banner').hidden = !S.mock && !S.demo;
  $('banner').innerHTML = S.demo
    ? `Demo: scans stay on this phone. Nothing is sent to Google Sheets. <button class="banner-btn" data-act="resetDemo">Reset demo</button>`
    : S.mock ? 'Practice mode: sample data, not your real sheet' : '';
  const r = S.route;
  if (r.name === 'setup' || !S.worker || (S.pinRequired && !S.pin)) return renderSetup(r.error);
  if (!S.snapshot) {
    view.innerHTML = `<div class="empty">Loading materials…</div>`;
    return;
  }
  if (r.name === 'material') return renderMaterial(r.sku);
  if (r.name === 'today') return renderToday();
  if (r.name === 'out') return renderOut();
  return renderHome();
}

function renderSetup(error = '') {
  view.innerHTML = `
    <section class="setup">
      <h1>Who's using this phone?</h1>
      <p class="muted">Your name goes next to every bottle you take or put back.</p>
      <label class="field"><span>Your name</span>
        <input id="nameIn" value="${esc(S.worker)}" autocomplete="name" placeholder="e.g. Ravi"></label>
      ${S.pinRequired ? `<label class="field"><span>App PIN</span>
        <input id="pinIn" type="password" inputmode="numeric" value="" placeholder="Ask your manager"></label>` : ''}
      <button class="big primary" data-act="saveSetup">Start</button>
      <p class="err" id="setupErr">${esc(error)}</p>
    </section>`;
}

function homeCounts() {
  const out = outList();
  const late = out.filter((s) => (minutesSince(s.iso) ?? 0) >= OUT_TOO_LONG_MIN).length;
  const todayLeft = S.today ? S.today.items.filter((i) => (!S.pilot || inUse(S.materials.get(i.sku))) && materialState(i.sku) !== 'done').length : null;
  return { out: out.length, late, todayLeft };
}

function renderHome() {
  const c = homeCounts();
  const searching = Boolean(S.search.trim());
  view.innerHTML = `
    <section class="home">
      <button class="big primary scan-btn" data-act="scan">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg>
        Scan rack or bottle
      </button>
      <input id="q" class="search" type="search" placeholder="Search material name or SKU" value="${esc(S.search)}" autocomplete="off" enterkeyhint="search">
      <div id="results" class="list"></div>
      <div id="homeRest" ${searching ? 'hidden' : ''}>
        ${S.pilot ? `<div class="pilot-note">Pilot: racks ${esc(pilotText())} only</div>` : ''}
        <div class="tiles">
          <button class="tile" data-act="nav" data-to="today">
            <span class="n">${c.todayLeft ?? '…'}</span><span>Today's list<br><small>left to fill</small></span>
          </button>
          <button class="tile ${c.late ? 'late' : c.out ? 'warn' : ''}" data-act="nav" data-to="out">
            <span class="n">${c.out}</span><span>Out now<br><small>${c.late ? `${c.late} too long` : 'off the shelf'}</small></span>
          </button>
        </div>
        <a class="foot-link" href="/labels">Print QR labels for racks and bottles</a>
      </div>
    </section>`;
  renderResults();
}

function searchMaterials(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const m of S.materials.values()) {
    if (!inUse(m)) continue;
    const hay = `${m.sku} ${m.name} ${m.address}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push(m);
    if (out.length >= 40) break;
  }
  return out.sort((a, b) => (a.sku.startsWith(q) ? -1 : 0) - (b.sku.startsWith(q) ? -1 : 0));
}

function renderResults() {
  const box = $('results');
  if (!box) return;
  const q = S.search.trim();
  const rest = $('homeRest');
  if (rest) rest.hidden = Boolean(q);
  if (!q) {
    box.innerHTML = '';
    return;
  }
  const found = searchMaterials(q);
  box.innerHTML = found.length
    ? found.map((m) => materialRow(m)).join('')
    : `<div class="empty">Nothing matches “${esc(q)}”.</div>`;
}

function materialRow(m) {
  const outs = m.locs.map((l) => statusOf(m.sku, l.code)).filter((st) => st?.status === 'OUT');
  return `
    <button class="row" data-act="material" data-sku="${esc(m.sku)}">
      <div class="loc-col">${esc(m.locs[0]?.label || '—')}${m.locs.length > 1 ? `<small>${m.locs.slice(1).map((l) => esc(l.label)).join(' · ')}</small>` : ''}</div>
      <div class="row-main">
        <div class="name">${esc(m.name || '(no name)')}</div>
        <div class="sub">SKU ${esc(m.sku)}</div>
      </div>
      <span class="state ${outs.length ? 'out' : 'done'}">${outs.length ? `Out · ${esc(outs[0].by)}` : 'In place'}</span>
    </button>`;
}

function renderMaterial(sku) {
  const m = S.materials.get(sku);
  if (!m) {
    view.innerHTML = `<button class="back" data-act="back">‹ Back</button><div class="empty">SKU ${esc(sku)} isn't in the location sheet.</div>`;
    return;
  }
  const todayItem = S.today?.items.find((i) => i.sku === sku);
  view.innerHTML = `
    <section class="material">
      <button class="back" data-act="back">‹ Back</button>
      <h1>${esc(m.name || '(no name)')}</h1>
      <div class="muted">SKU ${esc(m.sku)}</div>
      ${todayItem ? `<div class="need">Today: ${todayItem.sizes.map((s) => `${esc(s.size)} × ${s.count}`).join(' · ')}</div>` : ''}
      <div class="locs">
        ${m.locs.length ? m.locs.map((l) => locCard(m, l)).join('') : `<div class="empty">${S.pilot ? `Not on the pilot racks (${esc(pilotText())}).` : 'No location saved yet. Use “Move” to set one.'}</div>`}
      </div>
      ${m.otherLocs?.length ? `<div class="muted other-locs">Also stored at ${m.otherLocs.map((l) => `<span class="mono">${esc(l.label)}</span>`).join(', ')}${S.pilot ? ' (not part of the pilot)' : ''}</div>` : ''}
      ${(() => {
        const anyOut = m.locs.some((l) => isOut(m.sku, l.code));
        return `<button class="big primary" data-act="scan" data-target="${esc(m.sku)}">${anyOut ? 'Scan to put it back' : 'Scan to pick it'}</button>
      <button class="big ghost" data-act="elsewhere" data-sku="${esc(m.sku)}">${anyOut ? 'Put back on a different rack' : 'Move to another rack'}</button>`;
      })()}
    </section>`;
}

function locCard(m, l) {
  const st = statusOf(m.sku, l.code);
  const out = st?.status === 'OUT';
  const late = out && (minutesSince(st.iso) ?? 0) >= OUT_TOO_LONG_MIN;
  return `
    <div class="loc-card ${out ? 'out' : ''} ${late ? 'late' : ''}">
      <div class="loc-head">
        <span class="loc-code">${esc(l.label)}</span>
        ${l.note ? `<span class="loc-note">${esc(l.note)}</span>` : ''}
      </div>
      <div class="loc-status">${out ? `Out with <b>${esc(st.by)}</b> · ${ago(st.iso)}` : 'In place'}${st?.pending ? ' <span class="pending">· waiting to send</span>' : ''}</div>
      <button class="link" data-act="manual" data-kind="${out ? 'return' : 'take'}" data-sku="${esc(m.sku)}" data-code="${esc(l.code)}">
        ${out ? 'Mark put back (no scan)' : 'Mark taken (no scan)'}
      </button>
    </div>`;
}

function locationSortKey(item) {
  const m = S.materials.get(item.sku);
  const locs = m?.locs?.length ? m.locs : parseAddress(item.location);
  return locs[0]?.code || 'ZZZ';
}

function renderToday() {
  if (!S.today) {
    view.innerHTML = `<button class="back" data-act="back">‹ Back</button><div class="empty">Loading today's list…</div>`;
    loadToday().then(() => S.route.name === 'today' && renderToday()).catch((e) => showError(e));
    return;
  }
  const usable = S.today.items.filter((i) => !S.pilot || inUse(S.materials.get(i.sku)));
  const hiddenLines = S.today.items.filter((i) => !usable.includes(i)).reduce((n, i) => n + i.units, 0);
  const pilotLines = usable.reduce((n, i) => n + i.units, 0);
  const items = usable
    .map((i) => ({ ...i, state: materialState(i.sku), key: locationSortKey(i) }))
    .sort((a, b) => compareCodes(a.key, b.key));
  const counts = { todo: 0, out: 0, done: 0 };
  items.forEach((i) => counts[i.state]++);
  const f = S.todayFilter;
  const shown = f === 'all' ? items : items.filter((i) => i.state === f);
  const label = { todo: 'To do', out: 'Out', done: 'Done' };
  view.innerHTML = `
    <section class="today">
      <div class="head-row">
        <button class="back" data-act="back">‹ Back</button>
        <button class="link" data-act="reloadToday">Refresh</button>
      </div>
      <h1>Today's list</h1>
      <div class="muted">${pilotLines} bottles to fill · ${items.length} materials · sorted by rack</div>
      ${S.today.sample ? `<div class="pilot-note">${esc(S.today.sample)}.</div>` : ''}
      ${S.pilot && !S.today.sample ? `<div class="pilot-note">Pilot: showing racks ${esc(pilotText())} only.${hiddenLines ? ` ${hiddenLines} other bottles today are picked the usual way.` : ''}</div>` : ''}
      ${!S.online && S.today.savedAt && !S.today.sample ? `<div class="pilot-note">No connection: this is the list saved at ${esc(new Date(S.today.savedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}.</div>` : ''}
      <div class="filters">
        ${['todo', 'out', 'done', 'all'].map((k) => `<button class="filter ${f === k ? 'on' : ''}" data-act="todayFilter" data-f="${k}">${k === 'all' ? 'All' : label[k]} ${k === 'all' ? items.length : counts[k]}</button>`).join('')}
      </div>
      <div class="list">
        ${shown.length ? shown.map((i) => todayRow(i, label)).join('') : `<div class="empty">${f === 'todo' ? 'All done for today ✓' : 'Nothing here.'}</div>`}
      </div>
    </section>`;
}

function todayRow(i, label) {
  const m = S.materials.get(i.sku);
  const locs = m?.locs?.length ? m.locs : parseAddress(i.location);
  return `
    <button class="row today-row ${i.state}" data-act="material" data-sku="${esc(i.sku)}">
      <div class="loc-col">${esc(locs[0]?.label || '—')}${locs.length > 1 ? `<small>${locs.slice(1).map((l) => esc(l.label)).join(' · ')}</small>` : ''}</div>
      <div class="row-main">
        <div class="name">${esc(m?.name || i.name)}</div>
        <div class="sub">${i.sizes.map((s) => `${esc(s.size)} × ${s.count}`).join(' · ')}${i.orders > 1 ? ` · ${i.orders} orders` : ''}</div>
      </div>
      <span class="state ${i.state}">${label[i.state]}</span>
    </button>`;
}

function renderOut() {
  const list = outList();
  view.innerHTML = `
    <section>
      <button class="back" data-act="back">‹ Back</button>
      <h1>Out now</h1>
      <div class="muted">Bottles taken off the shelf and not scanned back yet. Oldest first.</div>
      <div class="list">
        ${list.length ? list.map((s) => {
          const m = S.materials.get(s.sku);
          const late = (minutesSince(s.iso) ?? 0) >= OUT_TOO_LONG_MIN;
          return `
            <button class="row ${late ? 'late-row' : ''}" data-act="material" data-sku="${esc(s.sku)}">
              <div class="loc-col">${esc(codeLabel(s.code))}</div>
              <div class="row-main">
                <div class="name">${esc(m?.name || s.material)}</div>
                <div class="sub">${esc(s.by)} · ${ago(s.iso)}${late ? ' · too long' : ''}</div>
              </div>
            </button>`;
        }).join('') : '<div class="empty">Everything is back in place ✓</div>'}
      </div>
    </section>`;
}

function showError(e) {
  if (e.pin) return go('setup', { error: 'Enter the PIN again' }, true);
  showSheet({ tone: 'bad', title: 'Problem', body: esc(e.message), buttons: [{ label: 'OK' }] });
}

// ---------- scanner ----------
async function openScanner({ target = null, bottle = null, intent = null } = {}) {
  S.ctx = { slot: null, bottle: bottle ? { sku: bottle, at: Date.now() } : null, target, goTo: null, intent };
  S.scanOpen = true;
  $('scanner').hidden = false;
  document.body.classList.add('no-scroll');
  history.pushState({ route: S.route, scanner: true }, '');
  beep('unlock'); // iPhones only allow sound after a tap
  updateScanStep();
  await startCamera();
}

async function closeScanner({ fromHistory = false } = {}) {
  if (!S.scanOpen) return;
  S.scanOpen = false;
  await stopCamera();
  $('scanner').hidden = true;
  document.body.classList.remove('no-scroll');
  if (sheetOpen()) hideSheet();
  if (!fromHistory && history.state?.scanner) history.back();
  render();
}

async function startCamera() {
  if (!window.Html5Qrcode) {
    setScanInfo(`<div class="warn-box">The camera scanner didn't load (no internet?). You can still type the code below.</div>`);
    return;
  }
  try {
    if (!S.qr) S.qr = new window.Html5Qrcode('reader', { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
    await S.qr.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.72); return { width: s, height: s }; } },
      onScanText,
      () => {},
    );
    S.camOn = true;
  } catch (e) {
    S.camOn = false;
    setScanInfo(`<div class="warn-box">Camera blocked. Allow camera for this site in your browser settings, then close and reopen the scanner. You can also type the code below.</div>`);
  }
}

async function stopCamera() {
  if (S.qr && S.camOn) {
    try { await S.qr.stop(); } catch { /* already stopped */ }
  }
  S.camOn = false;
}

function setScanInfo(html) {
  $('scanInfo').innerHTML = html;
}

function onScanText(text) {
  const now = Date.now();
  if (text === S.lastScan.text && now - S.lastScan.at < 2500) return; // same label still in view
  S.lastScan = { text, at: now };
  if (S.busy || sheetOpen()) return;
  handleScan(text);
}

function forgetOldScans() {
  const now = Date.now();
  if (S.ctx.slot && now - S.ctx.slot.at > SCAN_MEMORY_MS) S.ctx.slot = null;
  if (S.ctx.bottle && now - S.ctx.bottle.at > SCAN_MEMORY_MS) {
    S.ctx.bottle = null;
    S.ctx.goTo = null;
  }
}

function handleScan(text) {
  forgetOldScans();
  const c = classifyScan(text, { skus: S.skus, codes: S.codes, racks: S.racks });
  if (c.kind === 'unknown') {
    beep('bad');
    const outside = S.pilot && classifyScan(text, { skus: S.allSkus, codes: new Map(), racks: new Set() }).kind === 'bottle';
    setScanInfo(outside
      ? `<div class="warn-box"><b>${esc(text)}</b> isn't on the pilot racks (${esc(pilotText())}). Handle it the usual way for now.</div>`
      : `<div class="warn-box">Not recognised: <b>${esc(text)}</b><br>Not a rack label or a SKU in the location sheet${S.pilot ? ` for racks ${esc(pilotText())}` : ''}.</div>`);
    return;
  }
  // Refresh in the background while the worker reaches for the second item,
  // so we never decide take/return from stale data.
  if (Date.now() - S.loadedAt > 15_000) loadData().catch(() => {});

  if (c.kind === 'slot') S.ctx.slot = { code: c.code, at: Date.now() };
  else S.ctx.bottle = { sku: c.sku, at: Date.now() };
  beep('ok');

  if (S.ctx.slot && S.ctx.bottle) decide();
  else updateScanStep();
}

function materialsAt(code) {
  const out = [];
  for (const m of S.materials.values()) {
    const l = m.locs.find((x) => slotMatches(code, x.code));
    if (l) out.push({ m, l });
  }
  return out.sort((a, b) => compareCodes(a.l.code, b.l.code));
}

function updateScanStep() {
  forgetOldScans();
  const { slot, bottle, target, goTo } = S.ctx;
  const step = $('scanStep');
  if (slot && !bottle) {
    const here = materialsAt(slot.code);
    step.innerHTML = `<span class="tick">✓ Rack ${esc(codeLabel(slot.code))}</span><b>Now scan the bottle</b>`;
    const t = target && S.materials.get(target);
    const wrongRack = t && !t.locs.some((l) => slotMatches(slot.code, l.code));
    setScanInfo(`
      ${wrongRack ? `<div class="warn-box">${esc(t.name)} is not on this rack. It lives at <b>${t.locs.map((l) => esc(l.label)).join(', ') || '—'}</b>.</div>` : ''}
      <div class="here-title">${here.length} bottle${here.length === 1 ? '' : 's'} on this ${isRackCode(slot.code) ? 'rack' : 'slot'}</div>
      ${here.slice(0, 8).map(({ m, l }) => `<div class="here"><span>${l.code !== slot.code ? `<span class="mono slot-code">${esc(l.label)}</span> ` : ''}${esc(m.name)}</span>${isOut(m.sku, l.code) ? `<span class="chip out">out · ${esc(statusOf(m.sku, l.code).by)}</span>` : '<span class="chip">in</span>'}</div>`).join('')}
      ${here.length > 8 ? `<div class="muted">+ ${here.length - 8} more</div>` : ''}`);
    return;
  }
  if (bottle && !slot) {
    const m = S.materials.get(bottle.sku);
    const ask = goTo ? `Go to ${esc(codeLabel(goTo))} and scan that rack` : S.ctx.intent === 'elsewhere' ? 'Scan the rack you are putting it on' : 'Now scan the rack';
    step.innerHTML = `<span class="tick">✓ ${esc(m?.name || bottle.sku)}</span><b>${ask}</b>`;
    setScanInfo(m ? `<div class="here-title">Belongs at</div>${m.locs.map((l) => `<div class="here"><span class="mono">${esc(l.label)}</span>${isOut(m.sku, l.code) ? `<span class="chip out">out · ${esc(statusOf(m.sku, l.code).by)}</span>` : '<span class="chip">in place</span>'}</div>`).join('') || '<div class="muted">No location saved yet</div>'}` : '');
    return;
  }
  step.innerHTML = `<b>Scan the rack label or the bottle</b>`;
  const t = target && S.materials.get(target);
  setScanInfo(t ? `<div class="here-title">Looking for</div><div class="here"><span>${esc(t.name)}</span></div>${t.locs.map((l) => `<div class="here"><span class="mono">${esc(l.label)}</span>${isOut(t.sku, l.code) ? `<span class="chip out">out · ${esc(statusOf(t.sku, l.code).by)}</span>` : '<span class="chip">in place</span>'}</div>`).join('')}` : `<div class="muted">Taking a bottle: scan the rack, then the bottle.<br>Putting it back: scan the bottle, then the rack.</div>`);
}

async function decide() {
  if (S.loading) {
    // use fresh data if it arrives quickly; with bad signal decide from the saved copy
    await Promise.race([S.loading.catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
  }
  const { slot, bottle } = S.ctx;
  const m = S.materials.get(bottle.sku);
  if (!m) {
    S.ctx.bottle = null;
    beep('bad');
    setScanInfo(`<div class="warn-box">SKU ${esc(bottle.sku)} isn't in the location sheet.</div>`);
    return updateScanStep();
  }
  const slotLabel = codeLabel(slot.code);
  const match = m.locs.find((l) => l.code === slot.code) || m.locs.find((l) => slotMatches(slot.code, l.code));
  const outLocs = m.locs.filter((l) => isOut(m.sku, l.code));

  if (match && isOut(m.sku, match.code)) {
    return act({ action: 'return', sku: m.sku, code: match.code }, 'Back in place', `${esc(m.name)}<br>Put it in <span class="mono big-code">${esc(match.label)}</span>`);
  }
  const elsewhere = S.ctx.intent === 'elsewhere';
  if (elsewhere && match && !outLocs.length) {
    S.ctx.slot = null;
    return showSheet({ tone: 'info', title: 'Already on this rack', body: `${esc(m.name)} already lives at <span class="mono big-code">${esc(match.label)}</span>. Scan the other rack.`, buttons: [{ label: 'OK' }] });
  }
  if (elsewhere && !match && outLocs.length) return confirmMove(m, outLocs[0], slotLabel);
  if (match && !outLocs.length) {
    return act({ action: 'take', sku: m.sku, code: match.code }, 'Taken', `${esc(m.name)}<br>from <span class="mono big-code">${esc(match.label)}</span><br><small>When you're done, scan the bottle and the rack sticker again.</small>`);
  }
  if (match && outLocs.length) {
    // Another container of this material is already out. Ask what's happening.
    beep('bad');
    return showSheet({
      tone: 'warn',
      title: 'Which one is this?',
      body: `${esc(m.name)} already has a bottle out from <b>${outLocs.map((l) => esc(l.label)).join(', ')}</b>.`,
      buttons: [
        { label: `I'm taking the one at ${esc(match.label)}`, onClick: () => act({ action: 'take', sku: m.sku, code: match.code }, 'Taken', `${esc(m.name)}<br>from <span class="mono big-code">${esc(match.label)}</span>`) },
        { label: `I'm returning the ${esc(outLocs[0].label)} one`, style: 'ghost', onClick: () => { S.ctx.slot = null; S.ctx.goTo = outLocs[0].code; hideSheet(); } },
        { label: 'Cancel', style: 'ghost', onClick: cancelPair },
      ],
    });
  }
  if (outLocs.length) {
    beep('bad');
    const homes = outLocs.map((l) => esc(l.label)).join(' or ');
    return showSheet({
      tone: 'bad',
      title: 'Wrong rack',
      body: `${esc(m.name)} belongs at<br><span class="mono big-code">${homes}</span><br>You scanned <b>${esc(slotLabel)}</b>.`,
      buttons: [
        { label: `OK, I'll put it at ${homes}`, onClick: () => { S.ctx.slot = null; S.ctx.goTo = outLocs[0].code; hideSheet(); } },
        ...outLocs.map((l) => ({ label: `Move it to ${esc(slotLabel)} for good${outLocs.length > 1 ? ` (the ${esc(l.label)} one)` : ''}`, style: 'ghost', onClick: () => confirmMove(m, l, slotLabel) })),
      ],
    });
  }
  // Bottle is not out and this rack isn't one of its homes -> offer a move.
  return showSheet({
    tone: 'warn',
    title: `Move to ${esc(slotLabel)}?`,
    body: m.locs.length
      ? `${esc(m.name)} is listed at <b>${m.locs.map((l) => esc(l.label)).join(', ')}</b>, not ${esc(slotLabel)}.${slotPicker(slotLabel)}`
      : `${esc(m.name)} has no location saved yet.${slotPicker(slotLabel)}`,
    buttons: [
      ...(m.locs.length
        ? m.locs.map((l, i) => ({ label: `Move from ${esc(l.label)} → ${esc(slotLabel)}`, style: i === 0 ? 'primary' : 'ghost', onClick: () => { const to = withSlot(slotLabel); act({ action: 'move', sku: m.sku, fromCode: l.code, toLabel: to }, 'Moved', `${esc(m.name)}<br>${esc(l.label)} → <span class="mono big-code">${esc(to)}</span>`); } }))
        : []),
      { label: m.locs.length ? `Add ${esc(slotLabel)} as an extra location` : `Save ${esc(slotLabel)} as its location`, style: m.locs.length ? 'ghost' : 'primary', onClick: () => { const to = withSlot(slotLabel); act({ action: 'move', sku: m.sku, fromCode: '', toLabel: to }, 'Location saved', `${esc(m.name)}<br><span class="mono big-code">${esc(to)}</span>`); } },
      { label: 'Cancel', style: 'ghost', onClick: cancelPair },
    ],
  });
}

// Rack stickers say "1B3", not "1B3-2A". When moving onto a rack, ask which slot
// so the Address column stays exact. Leaving it empty saves just the rack.
const isRackCode = (code) => !String(code).includes('-');
function slotPicker(rackLabel) {
  if (!isRackCode(normalizeCode(rackLabel))) return '';
  return `<label class="slot-pick">Which slot on ${esc(rackLabel)}? <span class="muted">(column + row, e.g. 2A)</span>
    <input id="slotIn" data-rack="${esc(rackLabel)}" autocomplete="off" autocapitalize="characters" placeholder="e.g. 2A" maxlength="8"></label>
    <div id="slotPreview" class="muted slot-preview">Saves as <span class="mono">${esc(rackLabel)}</span></div>`;
}
function withSlot(rackLabel) {
  const v = ($('slotIn')?.value || '').toUpperCase().replace(/\s+/g, '').replace(/^-+/, '');
  return v ? `${rackLabel}-${v}` : rackLabel;
}

function confirmMove(m, from, toLabel) {
  showSheet({
    tone: 'warn',
    title: 'Change its home?',
    body: `${esc(m.name)} will be listed at <span class="mono big-code">${esc(toLabel)}</span> instead of ${esc(from.label)}. The location sheet updates for everyone.${slotPicker(toLabel)}`,
    buttons: [
      { label: `Yes, move to ${esc(toLabel)}`, onClick: () => { const to = withSlot(toLabel); act({ action: 'move', sku: m.sku, fromCode: from.code, toLabel: to }, 'Moved', `${esc(m.name)}<br>${esc(from.label)} → <span class="mono big-code">${esc(to)}</span>`); } },
      { label: 'Cancel', style: 'ghost', onClick: cancelPair },
    ],
  });
}

function cancelPair() {
  S.ctx.slot = null;
  S.ctx.bottle = null;
  S.ctx.goTo = null;
  S.ctx.intent = null;
  hideSheet();
}

/**
 * Record a scan: saved on the phone first (so nothing is lost without signal),
 * shown straight away, then sent to the sheet. With a good connection the worker
 * sees the sheet's answer; otherwise it's sent automatically later.
 */
async function act(payload, okTitle, okBody) {
  if (S.busy) return;
  S.busy = true;
  const op = { id: newId(), ...payload, worker: S.worker, at: localStamp(), iso: new Date().toISOString() };
  if (S.demo) {
    S.demoOps.push(op);
    saved.set(KEYS.demoOps, S.demoOps);
    rebuild();
    S.ctx = { slot: null, bottle: null, target: null, goTo: null };
    if (S.scanOpen) updateScanStep();
    S.busy = false;
    beep('done');
    showSheet({ tone: 'ok', title: `✓ ${okTitle}`, body: okBody, buttons: [{ label: S.scanOpen ? 'Scan next' : 'OK' }], autoClose: 4000 });
    if (!S.scanOpen) render();
    return;
  }
  S.outbox.push(op);
  saveQueue();
  rebuild();
  S.ctx = { slot: null, bottle: null, target: null, goTo: null };
  if (S.scanOpen) updateScanStep();

  let res = { queued: true };
  if (S.online && navigator.onLine !== false) {
    showSheet({ tone: 'info', title: 'Saving…', body: okBody });
    res = await Promise.race([
      flush().then((r) => r.get(op.id) || { queued: true }),
      new Promise((r) => setTimeout(() => r({ queued: true }), 6000)), // slow signal: don't keep the worker waiting
    ]);
  }
  S.busy = false;

  if (res.pin) {
    hideSheet();
    await closeScanner();
    return go('setup', { error: 'Enter the PIN again' }, true);
  }
  if (res.failed) {
    S.failed = S.failed.filter((f) => f.id !== op.id); // shown right now, no need to keep it in the list
    saveQueue();
    beep('bad');
    return showSheet({
      tone: 'bad',
      title: 'Not saved',
      body: `${esc(res.error)}<br><small>Nothing was changed.</small>`,
      buttons: [{ label: 'OK', onClick: cancelPair }],
    });
  }
  beep('done');
  const queued = res.queued
    ? `<div class="queued-note">${S.online ? 'Slow connection: saved on this phone and sending in the background.' : 'No connection: saved on this phone. It sends by itself when the connection is back. Keep scanning.'}</div>`
    : '';
  showSheet({ tone: 'ok', title: `✓ ${okTitle}`, body: okBody + queued, buttons: [{ label: S.scanOpen ? 'Scan next' : 'OK' }], autoClose: res.queued ? 5000 : 4000 });
  if (!S.scanOpen) render();
}

// ---------- sync status ----------
const actionName = { take: 'Taken', return: 'Put back', move: 'Moved' };
function opWhere(op) {
  if (op.action === 'move') return `${op.fromCode || 'new'} → ${normalizeCode(op.toLabel)}`;
  return op.code;
}
function opRow(op, extra = '') {
  const m = S.materials.get(op.sku);
  return `<div class="sync-row"><div><b>${actionName[op.action] || op.action}</b> · ${esc(m?.name || op.sku)}</div>
    <div class="muted"><span class="mono">${esc(opWhere(op))}</span> · ${esc(String(op.at).slice(11, 16))} · ${esc(op.worker)}</div>${extra}</div>`;
}

function renderSync() {
  const el = $('syncBtn');
  if (!el) return;
  const waiting = S.outbox.length;
  const failed = S.failed.length;
  let cls = '';
  let text = '';
  if (failed) { cls = 'bad'; text = `${failed} not saved`; }
  else if (!S.online) { cls = 'off'; text = waiting ? `Offline · ${waiting} waiting` : 'Offline'; }
  else if (waiting) { cls = 'sync'; text = `Sending ${waiting}…`; }
  el.hidden = !text;
  document.querySelector('.top')?.classList.toggle('has-sync', Boolean(text));
  el.className = `sync-pill ${cls}`;
  el.textContent = text;
}

function showSyncSheet() {
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const parts = [
    `<p>${S.online ? 'Connected.' : '<b>No connection.</b> Scans are saved on this phone and sent automatically when the connection is back. Closing the app is fine: they wait here.'}</p>`,
    `<p class="muted">Rack and bottle info last updated ${esc(when(S.snapshot?.savedAt))}.</p>`,
  ];
  if (S.outbox.length) parts.push(`<div class="here-title dark">Waiting to send (${S.outbox.length})</div>${S.outbox.map((op) => opRow(op)).join('')}`);
  if (S.failed.length) {
    parts.push(`<div class="here-title dark">Not saved (${S.failed.length})</div>${S.failed.map((op) => opRow(op, `<div class="err small">${esc(op.error)}</div>`)).join('')}
      <p class="muted">These were refused by the sheet, usually because another phone changed the same bottle first. Check the bottle and scan it again.</p>`);
  }
  if (!S.outbox.length && !S.failed.length) parts.push('<p>Everything is saved in the sheet ✓</p>');
  const buttons = [];
  if (S.outbox.length) buttons.push({ label: 'Send now', onClick: () => { hideSheet(); flush().then(() => S.failed.length && showSyncSheet()); } });
  if (S.failed.length) buttons.push({ label: 'Clear the not-saved list', style: 'ghost', onClick: () => { S.failed = []; saveQueue(); hideSheet(); } });
  buttons.push({ label: 'Close', style: 'ghost' });
  showSheet({ tone: S.failed.length ? 'bad' : S.online ? 'info' : 'warn', title: 'Sync', body: parts.join(''), buttons });
}

function refreshView() {
  if (S.scanOpen || sheetOpen() || S.route.name === 'setup' || !S.snapshot) return;
  if (document.activeElement?.id === 'q') renderResults();
  else render();
}

// ---------- events ----------
const actions = {
  home: () => go('home'),
  setup: () => go('setup'),
  back: () => history.back(),
  nav: (el) => go(el.dataset.to),
  material: (el) => go('material', { sku: el.dataset.sku }),
  scan: (el) => openScanner({ target: el.dataset.target || null }),
  elsewhere: (el) => openScanner({ bottle: el.dataset.sku, intent: 'elsewhere' }),
  closeScanner: () => closeScanner(),
  sync: () => showSyncSheet(),
  resetDemo: () => showSheet({
    tone: 'warn',
    title: 'Reset the demo?',
    body: `Puts every bottle back “in place” and undoes moves made on <b>this phone</b> (${S.demoOps.length} scan${S.demoOps.length === 1 ? '' : 's'} so far).`,
    buttons: [
      { label: 'Reset', onClick: () => { S.demoOps = []; saved.set(KEYS.demoOps, []); rebuild(); hideSheet(); go('home', {}, true); } },
      { label: 'Cancel', style: 'ghost' },
    ],
  }),
  sheetBtn: (el) => S.sheetHandlers[Number(el.dataset.i)]?.(),
  todayFilter: (el) => { S.todayFilter = el.dataset.f; renderToday(); },
  reloadToday: async () => {
    S.today = null;
    renderToday();
    await Promise.all([loadToday(true), loadData()]).catch(showError);
    renderToday();
  },
  manual: (el) => {
    const m = S.materials.get(el.dataset.sku);
    const l = m?.locs.find((x) => x.code === el.dataset.code);
    if (!m || !l) return;
    const taking = el.dataset.kind === 'take';
    showSheet({
      tone: 'warn',
      title: taking ? 'Mark as taken?' : 'Mark as put back?',
      body: `${esc(m.name)} at <span class="mono big-code">${esc(l.label)}</span><br><small>Scanning is better: it checks you have the right bottle and rack.</small>`,
      buttons: [
        { label: taking ? 'Yes, I took it' : 'Yes, it is back', onClick: () => act({ action: taking ? 'take' : 'return', sku: m.sku, code: l.code, note: 'marked without scanning' }, taking ? 'Taken' : 'Back in place', `${esc(m.name)}<br><span class="mono big-code">${esc(l.label)}</span>`) },
        { label: 'Cancel', style: 'ghost' },
      ],
    });
  },
  saveSetup: async () => {
    const name = $('nameIn').value.trim();
    const pin = $('pinIn') ? $('pinIn').value.trim() : S.pin;
    if (!name) {
      $('setupErr').textContent = 'Type your name first.';
      return;
    }
    if (S.pinRequired && !pin) {
      $('setupErr').textContent = 'Type the app PIN.';
      return;
    }
    S.worker = name;
    S.pin = pin;
    store.set('qr.worker', name);
    store.set('qr.pin', pin);
    $('setupErr').textContent = 'Checking…';
    try {
      await loadData();
      go('home', {}, true);
      loadToday().then(() => S.route.name === 'home' && renderHome()).catch(() => {});
    } catch (e) {
      S.route = { name: 'setup' };
      renderSetup(e.pin ? 'That PIN is not right.' : e.message);
    }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) {
    e.preventDefault();
    fn(el);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'slotIn' && $('slotPreview')) {
    $('slotPreview').innerHTML = `Saves as <span class="mono">${esc(withSlot(e.target.dataset.rack))}</span>`;
  }
  if (e.target.id === 'q') {
    S.search = e.target.value;
    renderResults();
  }
});

$('typeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('typeInput').value.trim();
  if (!v || S.busy || sheetOpen()) return;
  $('typeInput').value = '';
  $('typeInput').blur();
  handleScan(v);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.worker && Date.now() - S.loadedAt > 60_000) {
    loadData().then(() => !S.scanOpen && !sheetOpen() && render()).catch(() => {});
  }
  if (document.visibilityState === 'hidden' && S.scanOpen) stopCamera();
  else if (document.visibilityState === 'visible' && S.scanOpen && !S.camOn) startCamera();
});

setInterval(() => {
  if (document.visibilityState !== 'visible' || !S.worker || S.busy || S.scanOpen || sheetOpen()) return;
  if (S.route.name === 'setup') return;
  Promise.all([loadData(), S.today ? loadToday(true) : null])
    .then(refreshView)
    .catch(() => {});
}, REFRESH_MS);

// Keep trying to send waiting scans
setInterval(() => {
  if (S.outbox.length && !S.busy) flush();
}, 20_000);
window.addEventListener('online', () => {
  setOnline(true);
  flush();
  if (S.worker) loadData().then(refreshView).catch(() => {});
});
window.addEventListener('offline', () => setOnline(false));

// ---------- start ----------
(async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }
  S.pinRequired = saved.get(KEYS.pinRequired, false);
  try {
    const h = await apiFetch('/api/health', {}, 6000);
    S.pinRequired = Boolean(h.pinRequired);
    S.mock = Boolean(h.mock);
    S.demo = Boolean(h.demo);
    saved.set(KEYS.pinRequired, S.pinRequired);
    saved.set(KEYS.demo, S.demo);
    setOnline(true);
  } catch (e) {
    if (e.offline) setOnline(false);
  }
  history.replaceState({ route: S.route }, '');
  const ready = S.worker && !(S.pinRequired && !S.pin);
  if (ready && S.snapshot) {
    rebuild(); // show the saved copy straight away, even with no signal
    S.today = saved.get(KEYS.today, null);
  }
  render();
  renderSync();
  if (!ready) return;
  try {
    await loadData();
    render();
    flush();
    await loadToday();
    if (S.route.name === 'home') renderHome();
  } catch (e) {
    showError(e);
  }
})();

// expose for testing in the browser console
window.__stockFinder = { S, handleScan };
