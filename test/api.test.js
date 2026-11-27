// Runs the real API handlers against the in-memory sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOCK_SHEETS = '1';
process.env.MOCK_DELAY_MS = '0';
process.env.APP_PIN = '4321';

const { config } = await import('../lib/config.js');
const { mockBackend } = await import('../dev/mock-sheets.js');
const data = (await import('../api/data.js')).default;
const today = (await import('../api/today.js')).default;
const action = (await import('../api/action.js')).default;

function call(handler, { method = 'GET', body, pin = '4321', query = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      statusCode: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(obj) { resolve({ status: this.statusCode, body: obj }); },
    };
    handler({ method, body, query, headers: { 'x-app-pin': pin } }, res);
  });
}

const central = () => mockBackend.book[config.locationsSheetId][config.locationsTab];
const tab = (name) => mockBackend.book[config.appSheetId][name];
const addressOf = (sku) => central().find((r) => r[0] === sku)[2];

test('rejects a wrong PIN', async () => {
  const r = await call(data, { pin: 'nope' });
  assert.equal(r.status, 401);
});

test('loads materials and creates app tabs', async () => {
  const r = await call(data);
  assert.equal(r.status, 200);
  assert.ok(r.body.materials.length > 30);
  assert.ok(tab(config.statusTab));
  assert.deepEqual(tab(config.logTab)[0].slice(0, 3), ['Time', 'Worker', 'Action']);
});

test('groups the day list by material', async () => {
  const r = await call(today);
  const lily = r.body.items.find((i) => i.sku === '251205006');
  assert.equal(lily.units, 3);
  assert.equal(lily.orders, 2);
  const c12 = r.body.items.find((i) => i.sku === '220418004');
  assert.deepEqual(c12.sizes, [{ size: '10g', count: 1 }, { size: '50g', count: 1 }]);
});

test('take then return a bottle', async () => {
  let r = await call(action, { method: 'POST', body: { action: 'take', sku: '220418004', code: '1C3-3C', worker: 'Ravi', at: '2026-11-18 10:00:00' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status[0].status, 'OUT');
  r = await call(data);
  assert.equal(r.body.status.find((s) => s.key === '220418004|1C3-3C').status, 'OUT');

  r = await call(action, { method: 'POST', body: { action: 'return', sku: '220418004', code: '1C3-3C', worker: 'Ravi' } });
  assert.equal(r.body.status[0].status, 'IN');
  const rows = tab(config.statusTab).filter((x) => x[0] === '220418004|1C3-3C');
  assert.equal(rows.length, 1, 'one status row per container');
  const log = tab(config.logTab).map((x) => x[2]);
  assert.deepEqual(log.slice(1), ['TAKE', 'RETURN']);
});

test('refuses a location the material does not have', async () => {
  const r = await call(action, { method: 'POST', body: { action: 'take', sku: '220418004', code: '9Z9-9Z', worker: 'Ravi' } });
  assert.equal(r.status, 409);
});

test('move rewrites only that part of the Address cell', async () => {
  await call(action, { method: 'POST', body: { action: 'take', sku: '220208023', code: '1I4-1A', worker: 'Amit' } });
  const r = await call(action, { method: 'POST', body: { action: 'move', sku: '220208023', fromCode: '1I4-1A', toLabel: '2B1-1A', worker: 'Amit' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(addressOf('220208023'), 'PP12-5,PP13-4,2B1-1A, 1FF (Pdr) (5)');
  assert.deepEqual(r.body.removedKeys, ['220208023|1I4-1A']);
  const statusRows = tab(config.statusTab).filter((x) => String(x[0]).startsWith('220208023|'));
  assert.deepEqual(statusRows.map((x) => [x[0], x[4]]), [['220208023|2B1-1A', 'IN']]);
  const last = tab(config.logTab).at(-1);
  assert.equal(last[2], 'MOVE');
  assert.match(last[7], /Address was "PP12-5,PP13-4,1I4-1A, 1FF \(Pdr\) \(5\)"/);
});

test('move a bottle that has no location yet', async () => {
  central().push(['999000111', 'Test Material', '']);
  const r = await call(action, { method: 'POST', body: { action: 'move', sku: '999000111', toLabel: '3A1-1A', worker: 'Amit' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(addressOf('999000111'), '3A1-1A');
});

test('a retried action (same opId) is not saved twice', async () => {
  const body = { action: 'take', sku: '220418001', code: '1F4-4A', worker: 'Ravi', opId: 'op-dup-1', iso: new Date().toISOString() };
  const logBefore = tab(config.logTab).length;
  const a = await call(action, { method: 'POST', body });
  const b = await call(action, { method: 'POST', body });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(tab(config.logTab).length, logBefore + 1, 'only one log row');
  const row = tab(config.statusTab).find((x) => x[0] === '220418001|1F4-4A');
  assert.equal(row[9], 'op-dup-1');
});

test('uses the phone scan time and notes a late sync', async () => {
  const scanned = new Date(Date.now() - 47 * 60_000).toISOString();
  const r = await call(action, { method: 'POST', body: { action: 'take', sku: '220208001', code: '1D2-1C', worker: 'Ravi', opId: 'op-late-1', iso: scanned } });
  assert.equal(r.body.status[0].iso, scanned);
  const last = tab(config.logTab).at(-1);
  assert.equal(last[8], scanned);
  assert.match(last[7], /saved offline, synced 47 min later/);
});

test('a late scan does not overwrite a newer one from another phone', async () => {
  const t0 = Date.now();
  // Phone B (online) takes and returns at t0-10min and t0-5min
  await call(action, { method: 'POST', body: { action: 'take', sku: '220418002', code: '1F4-5A', worker: 'Amit', opId: 'b1', iso: new Date(t0 - 10 * 60_000).toISOString() } });
  await call(action, { method: 'POST', body: { action: 'return', sku: '220418002', code: '1F4-5A', worker: 'Amit', opId: 'b2', iso: new Date(t0 - 5 * 60_000).toISOString() } });
  // Phone A was offline: its take from t0-20min arrives now
  const r = await call(action, { method: 'POST', body: { action: 'take', sku: '220418002', code: '1F4-5A', worker: 'Ravi', opId: 'a1', iso: new Date(t0 - 20 * 60_000).toISOString() } });
  assert.equal(r.body.stale, true);
  const row = tab(config.statusTab).find((x) => x[0] === '220418002|1F4-5A');
  assert.deepEqual([row[4], row[5]], ['IN', 'Amit'], 'newer return kept');
  const last = tab(config.logTab).at(-1);
  assert.equal(last[2], 'TAKE');
  assert.match(last[7], /not applied: newer scan by Amit already saved/);
});

test('ignores a phone clock that is far ahead', async () => {
  const r = await call(action, { method: 'POST', body: { action: 'take', sku: '220418003', code: '1F5-3A', worker: 'Ravi', opId: 'clock-1', iso: '2030-01-01T00:00:00.000Z' } });
  assert.ok(Date.parse(r.body.status[0].iso) <= Date.now());
});

test('old 9-column tabs get the new Op ID header', async () => {
  const { ensureTabs } = await import('../lib/store.js');
  assert.equal(tab(config.statusTab)[0][9], 'Op ID');
  assert.equal(tab(config.logTab)[0][9], 'Op ID');
  assert.equal(typeof ensureTabs, 'function');
});
