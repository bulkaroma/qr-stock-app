// With no Google key set, the app runs as a demo and never contacts Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
delete process.env.MOCK_SHEETS;
delete process.env.DEMO_MODE;
process.env.APP_PIN = '1234';
let googleCalls = 0;
globalThis.fetch = async () => { googleCalls++; throw new Error('network should not be used in demo mode'); };

const health = (await import('../api/health.js')).default;
const data = (await import('../api/data.js')).default;
const today = (await import('../api/today.js')).default;
const action = (await import('../api/action.js')).default;

const call = (handler, { method = 'GET', body, query = {}, pin = '1234' } = {}) => new Promise((resolve) => {
  const res = { setHeader() {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  handler({ method, body, query, headers: { 'x-app-pin': pin } }, res);
});

test('demo mode turns on by itself without a Google key', async () => {
  const r = await call(health, { query: { deep: '1', pin: '1234' } });
  assert.equal(r.body.demo, true);
  assert.equal(r.body.checks[0].label, 'Demo mode');
});

test('serves the built-in shelf B copy', async () => {
  const r = await call(data);
  assert.equal(r.status, 200);
  assert.equal(r.body.materials.length, 74);
  assert.deepEqual(r.body.pilotRacks, ['1B1', '1B2', '1B3', '1B4', '1B5']);
  assert.deepEqual(r.body.status, []);
  const t = await call(today);
  assert.equal(t.body.lines, 23);
  assert.match(t.body.sample, /Sample list/);
  assert.ok(!JSON.stringify(t.body).includes('Customer'));
});

test('still needs the PIN when one is set', async () => {
  const r = await call(data, { pin: 'nope' });
  assert.equal(r.status, 401);
});

test('never writes anywhere', async () => {
  const r = await call(action, { method: 'POST', body: { action: 'take', sku: '220208092', code: '1B5-1A', worker: 'Ravi' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Demo mode/);
  assert.equal(googleCalls, 0);
});
