// In-memory stand-in for Google Sheets, used when MOCK_SHEETS=1.
import fs from 'node:fs';
import { config } from '../lib/config.js';
import { centralRows, qrRows } from './fixtures.js';

// MOCK_CENTRAL_FILE=path.json swaps the sample materials for a full export of
// Central Location Info (rows from row 3 down), e.g. to print real labels offline.
const central = process.env.MOCK_CENTRAL_FILE
  ? JSON.parse(fs.readFileSync(process.env.MOCK_CENTRAL_FILE, 'utf8'))
  : centralRows;

const book = {
  [config.locationsSheetId]: {
    [config.locationsTab]: [['spira', 'Calc.', 'ME'], ['SKU', 'Material Name', 'Address'], ...central.map((r) => [...r])],
  },
  [config.ordersSheetId]: {
    [config.ordersTab]: [
      ['SKU', 'Item Count', 'Customer Name (Shipping)', 'Order Name', 'Product Title', 'Variant Title', 'Location', 'Order Item Quantity', 'True Total Number of Items', 'QR Code'],
      ...qrRows.map((r) => [...r]),
    ],
  },
};
if (!book[config.appSheetId]) book[config.appSheetId] = {};

// MOCK_SEED=1 starts the practice sheet with a few bottles already out (one for too long)
// and one put back today, so every screen has something to show.
if (process.env.MOCK_SEED === '1') {
  const stamp = (minsAgo) => {
    const d = new Date(Date.now() - minsAgo * 60000);
    const p = (n) => String(n).padStart(2, '0');
    return [`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, d.toISOString()];
  };
  const seed = [
    ['220208092', 'Habanolide® - dsm-firmenich', '1B5-1A', 'OUT', 'Amit', 25],
    ['220208029', 'Benzophenone', '1I4-5B', 'OUT', 'Suresh', 190],
    ['251031004', 'Aquaflora - IFF', '1B2-6A', 'IN', 'Amit', 70],
  ];
  const status = [['Key', 'SKU', 'Material', 'Location', 'Status', 'By', 'Updated', 'Updated (ISO)', 'Note']];
  const log = [['Time', 'Worker', 'Action', 'SKU', 'Material', 'From', 'To', 'Note', 'Time (ISO)']];
  for (const [sku, name, loc, st, by, mins] of seed) {
    const [at, iso] = stamp(mins);
    status.push([`${sku}|${loc}`, sku, name, loc, st, by, at, iso, '']);
    if (st === 'IN') {
      const [at2, iso2] = stamp(mins + 18);
      log.push([at2, by, 'TAKE', sku, name, loc, '', '', iso2]);
      log.push([at, by, 'RETURN', sku, name, '', loc, '', iso]);
    } else {
      log.push([at, by, 'TAKE', sku, name, loc, '', '', iso]);
    }
  }
  log.splice(1, log.length - 1, ...log.slice(1).sort((a, b) => a[8].localeCompare(b[8])));
  book[config.appSheetId][config.statusTab] = status;
  book[config.appSheetId][config.logTab] = log;
}

const col = (letters) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function parse(range) {
  const m = range.match(/^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  if (!m) throw new Error(`Mock: bad range ${range}`);
  const tab = (m[1] ?? m[2]).replace(/''/g, "'");
  const c1 = col(m[3]);
  const r1 = m[4] ? Number(m[4]) - 1 : 0;
  const c2 = m[5] ? col(m[5]) : c1;
  const r2 = m[6] ? Number(m[6]) - 1 : m[5] ? Infinity : m[4] ? r1 : Infinity;
  return { tab, c1, r1, c2, r2 };
}

function grid(id, tab) {
  const g = book[id]?.[tab];
  if (!g) {
    const err = new Error(`Unable to parse range: ${tab}`);
    err.status = 502;
    throw err;
  }
  return g;
}

const delay = () => new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS || 30)));

function read(id, range) {
  const { tab, c1, r1, c2, r2 } = parse(range);
  const g = grid(id, tab);
  const out = [];
  for (let r = r1; r < g.length && r <= r2; r++) {
    const row = (g[r] || []).slice(c1, c2 + 1).map((v) => (v == null ? '' : String(v)));
    while (row.length && row[row.length - 1] === '') row.pop();
    out.push(row);
  }
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

function write(id, range, values) {
  const { tab, c1, r1 } = parse(range);
  const g = grid(id, tab);
  values.forEach((vals, i) => {
    const r = r1 + i;
    while (g.length <= r) g.push([]);
    vals.forEach((v, j) => {
      g[r][c1 + j] = v;
    });
  });
}

export const mockBackend = {
  book,
  async getValues(id, range) {
    await delay();
    return read(id, range);
  },
  async batchGet(id, ranges) {
    await delay();
    return ranges.map((r) => read(id, r));
  },
  async update(id, range, values) {
    await delay();
    write(id, range, values);
    return {};
  },
  async append(id, range, values) {
    await delay();
    const { tab, c1, c2 } = parse(range);
    const g = grid(id, tab);
    let last = -1;
    g.forEach((row, i) => {
      if ((row || []).slice(c1, c2 + 1).some((v) => v !== '' && v != null)) last = i;
    });
    const start = last + 1;
    values.forEach((vals, i) => {
      g[start + i] = [];
      vals.forEach((v, j) => (g[start + i][c1 + j] = v));
    });
    return {};
  },
  async sheetTitles(id) {
    await delay();
    return Object.keys(book[id] || {});
  },
  async addSheet(id, title) {
    await delay();
    book[id] = book[id] || {};
    book[id][title] = [];
    return {};
  },
};
