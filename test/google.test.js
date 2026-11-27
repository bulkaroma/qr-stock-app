// Checks the Google client signs its login correctly and builds the right Sheets requests,
// using a throwaway key and a fake network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'stock-app@demo-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} });
  if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ access_token: 'tok-123', expires_in: 3600 }), { status: 200 });
  }
  if (String(url).includes('forbidden')) {
    return new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status: 403 });
  }
  return new Response(JSON.stringify({ values: [['a', 'b']], valueRanges: [{ values: [['x']] }, {}], sheets: [{ properties: { title: 'T1' } }] }), { status: 200 });
};

const { google } = await import('../lib/google.js');

test('signs a valid service-account login', async () => {
  await google.getValues('SHEET', "'Central Location Info'!A3:C");
  const tokenCall = calls.find((c) => c.url.includes('oauth2'));
  const assertion = new URLSearchParams(tokenCall.body.toString()).get('assertion');
  const [h, p, s] = assertion.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  const claim = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claim.iss, 'stock-app@demo-project.iam.gserviceaccount.com');
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/spreadsheets');
});

test('builds Sheets API requests', async () => {
  calls.length = 0;
  const v = await google.getValues('SHEET', "'Central Location Info'!A3:C");
  assert.deepEqual(v, [['a', 'b']]);
  assert.equal(calls[0].url, "https://sheets.googleapis.com/v4/spreadsheets/SHEET/values/'Central%20Location%20Info'!A3%3AC?valueRenderOption=FORMATTED_VALUE");
  assert.equal(calls[0].headers.Authorization, 'Bearer tok-123');

  calls.length = 0;
  const both = await google.batchGet('SHEET', ["'A b'!A1:B", "'QR App Status'!A2:I"]);
  assert.deepEqual(both, [[['x']], []]);
  assert.match(calls[0].url, /values:batchGet\?valueRenderOption=FORMATTED_VALUE&ranges='A%20b'!A1%3AB&ranges='QR%20App%20Status'!A2%3AI$/);

  calls.length = 0;
  await google.update('SHEET', "'Central Location Info'!C57", [['1C3-3C,6A3']]);
  assert.equal(calls[0].method, 'PUT');
  assert.match(calls[0].url, /values\/'Central%20Location%20Info'!C57\?valueInputOption=RAW$/);
  assert.deepEqual(JSON.parse(calls[0].body), { values: [['1C3-3C,6A3']] });

  calls.length = 0;
  await google.append('SHEET', "'QR App Log'!A:I", [['row']]);
  assert.match(calls[0].url, /values\/'QR%20App%20Log'!A%3AI:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS$/);

  calls.length = 0;
  await google.addSheet('SHEET', 'QR App Log');
  assert.equal(calls[0].url, 'https://sheets.googleapis.com/v4/spreadsheets/SHEET:batchUpdate');
  assert.deepEqual(JSON.parse(calls[0].body), { requests: [{ addSheet: { properties: { title: 'QR App Log' } } }] });
});

test('explains a permission error in plain words', async () => {
  await assert.rejects(google.getValues('forbidden', "'X'!A1"), /Share the sheet with stock-app@demo-project\.iam\.gserviceaccount\.com as Editor/);
});
