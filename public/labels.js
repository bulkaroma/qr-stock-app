import { parseAddress, rackOf, compareCodes, normalizeCode, slotMatches } from './locations.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const getPin = () => { try { return localStorage.getItem('qr.pin') || ''; } catch { return ''; } };
const setPin = (v) => { try { localStorage.setItem('qr.pin', v); } catch { /* ignore */ } };

let materials = [];
let pilot = null; // Set of racks when the app runs a pilot

function qrSvg(text) {
  if (!window.qrcode) return '<svg viewBox="0 0 10 10"><text x="0" y="6" font-size="2">QR lib missing</text></svg>';
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  // margin = 2 modules of white around the code so phone cameras lock on quickly
  const svg = q.createSvgTag({ cellSize: 2, margin: 4, scalable: true });
  // Let CSS size it: drop any fixed width/height on the outer <svg> tag only
  return svg.replace(/^<svg[^>]*>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, ''));
}

async function load() {
  $('msg').textContent = '';
  const res = await fetch('/api/data', { headers: { 'x-app-pin': getPin() } });
  if (res.status === 401) {
    $('msg').innerHTML = 'Enter the app PIN: <input id="pinIn" type="password" style="font:inherit;padding:6px 8px;border:1px solid #ccc;border-radius:6px"> <button id="pinGo" type="button" style="font:inherit;padding:6px 12px">OK</button>';
    $('pinGo').onclick = () => { setPin($('pinIn').value.trim()); load(); };
    return;
  }
  const data = await res.json();
  if (!res.ok) {
    $('msg').textContent = data.error || 'Could not load materials';
    return;
  }
  pilot = data.pilotRacks?.length ? new Set(data.pilotRacks) : null;
  $('pilotWrap').hidden = !pilot;
  if (pilot) $('pilotText').textContent = [...pilot].sort(compareCodes).join(', ');
  materials = data.materials.map((m) => ({ ...m, locs: parseAddress(m.address) }));
  render();
}

const pilotOnly = () => pilot && $('pilotOnly').checked;
const onPilot = (code) => !pilotOnly() || pilot.has(rackOf(code));

// Rack filter: "1B" keeps codes starting with 1B (racks 1B1, 1B2 … and their slots)
const codeFilter = () => $('filter').value.trim().toUpperCase().replace(/\s+/g, '');

/** Rack (or slot) stickers. Returns [{ key, html }] so they can be mixed with bottle stickers. */
function rackLabels() {
  const level = $('level').value;
  const includePP = $('pp').checked;
  const f = codeFilter();
  const map = new Map(); // code -> label
  for (const m of materials) {
    for (const l of m.locs) {
      if (!onPilot(l.code)) continue;
      const code = level === 'rack' ? rackOf(l.code) : l.code;
      if (!includePP && code.startsWith('PP')) continue;
      if (f && !code.startsWith(f)) continue;
      if (!map.has(code)) map.set(code, level === 'rack' ? code : l.label);
    }
  }
  // Extra codes typed by hand: racks or slots with nothing listed yet
  for (const extra of $('extra').value.split(',')) {
    const code = normalizeCode(extra);
    if (code && !map.has(code)) map.set(code, code);
  }
  return [...map.entries()].map(([code, label]) => {
    const here = materials.filter((m) => m.locs.some((l) => slotMatches(code, l.code)));
    const isRack = here.some((m) => m.locs.some((l) => l.code !== code && slotMatches(code, l.code)));
    const meta = here.length === 1 && !isRack
      ? `<div class="nm">${esc(here[0].name)}</div>`
      : `<div class="meta">${isRack ? 'RACK · ' : ''}${here.length ? `${here.length} bottle${here.length === 1 ? '' : 's'}` : 'empty'}</div>`;
    return {
      key: code,
      html: `
      <div class="label${isRack || level === 'rack' ? ' rack' : ''}">
        <div class="qr">${qrSvg(`L:${code}`)}</div>
        <div class="txt">
          <div class="code">${esc(label)}</div>
          ${meta}
        </div>
      </div>`,
    };
  });
}

/** Bottle stickers (QR = SKU), with the home slot printed so workers know where it goes. */
function bottleLabels({ mixed = false } = {}) {
  const per = mixed ? 'loc' : $('per').value;
  const includePP = $('pp').checked;
  const f = codeFilter();
  const words = mixed ? [] : $('filter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = []; // one per label: { m, home, locs }
  for (const m of materials) {
    if (!words.every((w) => `${m.sku} ${m.name} ${m.address}`.toLowerCase().includes(w))) continue;
    const locs = m.locs.filter((l) => (includePP || !l.code.startsWith('PP')) && onPilot(l.code) && (!mixed || !f || l.code.startsWith(f)));
    if ((pilotOnly() || mixed) && !locs.length) continue;
    if (per === 'loc' && locs.length) locs.forEach((home) => entries.push({ m, home, locs }));
    else entries.push({ m, home: null, locs });
  }
  return entries.map(({ m, home, locs }) => ({
    key: (home || locs[0])?.code || 'ZZZ',
    html: `
        <div class="label">
          <div class="qr">${qrSvg(m.sku)}</div>
          <div class="txt">
            <div class="nm">${esc(m.name || '(no name)')}</div>
            <div class="meta">SKU ${esc(m.sku)}</div>
            ${home ? `<div class="home">${esc(home.label)}</div>` : `<div class="meta">${locs.map((l) => esc(l.label)).join(' · ')}</div>`}
          </div>
        </div>`,
  }));
}

function render() {
  const kind = $('kind').value;
  $('levelWrap').hidden = kind === 'bottles';
  $('extraWrap').hidden = kind === 'bottles';
  $('perWrap').hidden = kind !== 'bottles';
  $('filterLabel').textContent = kind === 'bottles' ? 'Only show (SKU, name or rack)' : 'Only racks starting with';
  $('filter').placeholder = kind === 'bottles' ? 'e.g. Aldehyde' : 'e.g. 1B';
  const size = $('size').value;
  document.body.className = size;
  $('pageRule').textContent = size === 'a4' ? '@page { size: A4; margin: 6mm; }' : size === 't50' ? '@page { size: 50mm 30mm; margin: 0; }' : '@page { size: 38mm 25mm; margin: 0; }';
  const items = kind === 'racks' ? rackLabels() : kind === 'bottles' ? bottleLabels() : [...rackLabels(), ...bottleLabels({ mixed: true })];
  // Shelf order. In "racks and their bottles", each rack sticker comes first, then that rack's bottles.
  items.sort((a, b) => compareCodes(a.key, b.key));
  const labels = items.map((i) => i.html);
  $('count').textContent = `${labels.length} label${labels.length === 1 ? '' : 's'}${size === 'a4' ? ` · ${Math.ceil(labels.length / 24)} A4 page${Math.ceil(labels.length / 24) === 1 ? '' : 's'}` : ''}`;
  $('sheet').innerHTML = labels.join('') || '<p style="padding:20px;color:#5d6967">No labels match.</p>';
}

let t;
['kind', 'level', 'per', 'size', 'pp', 'pilotOnly'].forEach((id) => $(id).addEventListener('change', render));
$('extra').addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 300); });
$('filter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 250); });
$('printBtn').addEventListener('click', () => window.print());

window.addEventListener('load', () => load().catch((e) => { $('msg').textContent = e.message; }));
