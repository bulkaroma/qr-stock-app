// Reads and writes the app's data in Google Sheets.
import { config, STATUS_HEADERS, LOG_HEADERS } from './config.js';
import { ApiError } from './http.js';
import { replaceLocation, statusKey } from '../public/locations.js';

let backendPromise = null;
export function backend() {
  if (!backendPromise) {
    backendPromise =
      process.env.MOCK_SHEETS === '1'
        ? import('../dev/mock-sheets.js').then((m) => m.mockBackend)
        : import('./google.js').then((m) => m.google);
  }
  return backendPromise;
}

export const a1 = (tab, range) => `'${tab.replace(/'/g, "''")}'!${range}`;

const colIndex = (letters) =>
  letters.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const colLetter = (index) => {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// ---------- materials (Central Location Info) ----------

const matCols = () => {
  const idx = { sku: colIndex(config.skuCol), name: colIndex(config.nameCol), address: colIndex(config.addressCol) };
  const min = Math.min(idx.sku, idx.name, idx.address);
  const max = Math.max(idx.sku, idx.name, idx.address);
  return { idx, min, max, range: `${colLetter(min)}${config.locationsFirstRow}:${colLetter(max)}` };
};

function rowsToMaterials(rows) {
  const { idx, min } = matCols();
  const list = [];
  rows.forEach((r, i) => {
    const sku = String(r[idx.sku - min] ?? '').trim();
    if (!sku) return;
    list.push({
      row: config.locationsFirstRow + i,
      sku,
      name: String(r[idx.name - min] ?? '').trim(),
      address: String(r[idx.address - min] ?? ''),
    });
  });
  return list;
}

let matCache = null;
const MAT_TTL = 30_000;

function setMatCache(list) {
  matCache = { at: Date.now(), list, bySku: new Map(list.map((m) => [m.sku, m])) };
  return matCache;
}

export async function readMaterials({ fresh = false } = {}) {
  if (!fresh && matCache && Date.now() - matCache.at < MAT_TTL) return matCache;
  const b = await backend();
  const rows = await b.getValues(config.locationsSheetId, a1(config.locationsTab, matCols().range));
  return setMatCache(rowsToMaterials(rows));
}

export async function findMaterial(sku) {
  let mats = await readMaterials();
  let m = mats.bySku.get(String(sku).trim());
  if (!m) {
    mats = await readMaterials({ fresh: true });
    m = mats.bySku.get(String(sku).trim());
  }
  if (!m) throw new ApiError(404, `SKU ${sku} is not in ${config.locationsTab}`);
  return m;
}

/** Rewrite one material's Address cell, replacing one location with another. */
export async function updateAddress(sku, fromCode, toLabel) {
  const b = await backend();
  const mats = await readMaterials({ fresh: true }); // fresh row numbers before writing
  const m = mats.bySku.get(String(sku).trim());
  if (!m) throw new ApiError(404, `SKU ${sku} is not in ${config.locationsTab}`);
  const oldAddress = m.address;
  const newAddress = replaceLocation(oldAddress, fromCode, toLabel);
  await b.update(config.locationsSheetId, a1(config.locationsTab, `${config.addressCol}${m.row}`), [[newAddress]]);
  m.address = newAddress;
  return { sku: m.sku, name: m.name, oldAddress, newAddress };
}

// ---------- app tabs (status + log) ----------

let tabsReady = false;
export async function ensureTabs() {
  if (tabsReady) return;
  const b = await backend();
  const titles = await b.sheetTitles(config.appSheetId);
  for (const [tab, headers] of [
    [config.statusTab, STATUS_HEADERS],
    [config.logTab, LOG_HEADERS],
  ]) {
    if (!titles.includes(tab)) {
      await b.addSheet(config.appSheetId, tab);
      await b.update(config.appSheetId, a1(tab, 'A1'), [headers]);
    } else {
      // Tabs made by an earlier version have 9 columns: add the new header(s).
      const [head = []] = await b.getValues(config.appSheetId, a1(tab, 'A1:J1'));
      if (head.length < headers.length) await b.update(config.appSheetId, a1(tab, 'A1'), [headers]);
    }
  }
  tabsReady = true;
}

function rowsToStatus(rows) {
  const byKey = new Map();
  rows.forEach((r, i) => {
    const key = String(r[0] ?? '').trim();
    if (!key) return;
    byKey.set(key, {
      row: 2 + i,
      key,
      sku: String(r[1] ?? ''),
      material: String(r[2] ?? ''),
      code: String(r[3] ?? ''),
      status: String(r[4] ?? '').toUpperCase(),
      by: String(r[5] ?? ''),
      at: String(r[6] ?? ''),
      iso: String(r[7] ?? ''),
      note: String(r[8] ?? ''),
      opId: String(r[9] ?? ''),
    }); // later rows win if a key was ever written twice
  });
  return byKey;
}

const statusRange = () => a1(config.statusTab, 'A2:J');

export async function readStatus() {
  await ensureTabs();
  const b = await backend();
  return rowsToStatus(await b.getValues(config.appSheetId, statusRange()));
}

/** Materials + status in as few Google calls as possible (one, when they share a spreadsheet). */
export async function readEverything() {
  await ensureTabs();
  const b = await backend();
  if (config.appSheetId === config.locationsSheetId) {
    const [matRows, statusRows] = await b.batchGet(config.locationsSheetId, [
      a1(config.locationsTab, matCols().range),
      statusRange(),
    ]);
    return { materials: setMatCache(rowsToMaterials(matRows)).list, status: rowsToStatus(statusRows) };
  }
  const [mats, status] = await Promise.all([readMaterials({ fresh: true }), readStatus()]);
  return { materials: mats.list, status };
}

const statusRow = (e) => [e.key, e.sku, e.material, e.code, e.status, e.by, e.at, e.iso, e.note || '', e.opId || ''];

/**
 * Write one container's status. If `replaceKey` is given (a move), that row is
 * rewritten for the new location instead of adding a new row.
 */
export async function writeStatus(entry, { replaceKey, all: known } = {}) {
  const b = await backend();
  const all = known || (await readStatus());
  const existing = (replaceKey && all.get(replaceKey)) || all.get(entry.key);
  if (existing) {
    await b.update(config.appSheetId, a1(config.statusTab, `A${existing.row}:J${existing.row}`), [statusRow(entry)]);
    // A move onto a location that already had its own row: clear the duplicate.
    const dup = all.get(entry.key);
    if (replaceKey && dup && dup.row !== existing.row) {
      await b.update(config.appSheetId, a1(config.statusTab, `A${dup.row}:J${dup.row}`), [Array(10).fill('')]);
    }
    return { ...entry, row: existing.row };
  }
  await b.append(config.appSheetId, a1(config.statusTab, 'A:J'), [statusRow(entry)]);
  return entry;
}

export async function appendLog(e) {
  const b = await backend();
  await b.append(config.appSheetId, a1(config.logTab, 'A:J'), [
    [e.at, e.worker, e.action, e.sku, e.material, e.from || '', e.to || '', e.note || '', e.iso, e.opId || ''],
  ]);
}

export function makeStatus({ sku, material, code, status, by, at, iso, note, opId }) {
  return { key: statusKey(sku, code), sku, material, code, status, by, at, iso, note: note || '', opId: opId || '' };
}

// ---------- today's order list (QR Sheet) ----------

export async function readToday() {
  const b = await backend();
  const rows = await b.getValues(config.ordersSheetId, a1(config.ordersTab, 'A2:J'));
  const bySku = new Map();
  let lines = 0;
  for (const r of rows) {
    const sku = String(r[0] ?? '').trim();
    if (!sku) continue;
    lines++;
    const size = String(r[5] ?? '').trim() || '—';
    const order = String(r[3] ?? '').trim();
    let item = bySku.get(sku);
    if (!item) {
      item = { sku, name: String(r[4] ?? '').trim(), location: String(r[6] ?? '').trim(), units: 0, sizes: {}, orders: new Set() };
      bySku.set(sku, item);
    }
    item.units++;
    item.sizes[size] = (item.sizes[size] || 0) + 1;
    if (order) item.orders.add(order);
  }
  const items = [...bySku.values()].map((i) => ({
    sku: i.sku,
    name: i.name,
    location: i.location,
    units: i.units,
    orders: i.orders.size,
    sizes: Object.entries(i.sizes)
      .map(([size, count]) => ({ size, count }))
      .sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true })),
  }));
  return { items, lines };
}
