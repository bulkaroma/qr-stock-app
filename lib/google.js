// Minimal Google Sheets client using a service account. No npm packages needed.
import crypto from 'node:crypto';
import { ApiError } from './http.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

let cachedToken = null;

function credentials() {
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json);
      email = parsed.client_email;
      key = parsed.private_key;
    } catch {
      throw new ApiError(500, 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file contents.');
    }
  }
  if (!email || !key) {
    throw new ApiError(500, 'Google access is not set up. Add GOOGLE_SERVICE_ACCOUNT_JSON in Vercel → Settings → Environment Variables.');
  }
  key = key.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
  return { email, key };
}

export function serviceAccountEmail() {
  try {
    return credentials().email;
  } catch {
    return null;
  }
}

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 120 > now) return cachedToken.token;

  const { email, key } = credentials();
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
  } catch {
    throw new ApiError(500, 'The Google private key could not be read. Re-copy the key file into GOOGLE_SERVICE_ACCOUNT_JSON.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(500, `Google sign-in failed: ${data.error_description || data.error || res.status}`);
  cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken();
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 404) {
        throw new ApiError(502, `Google Sheets refused access (${msg}). Share the sheet with ${serviceAccountEmail()} as Editor.`);
      }
      throw new ApiError(502, `Google Sheets error: ${msg}`);
    }
    return data;
  }
}

const enc = encodeURIComponent;

export const google = {
  async getValues(id, range) {
    const data = await call('GET', `${BASE}/${id}/values/${enc(range)}?valueRenderOption=FORMATTED_VALUE`);
    return data.values || [];
  },
  async batchGet(id, ranges) {
    const qs = ranges.map((r) => `ranges=${enc(r)}`).join('&');
    const data = await call('GET', `${BASE}/${id}/values:batchGet?valueRenderOption=FORMATTED_VALUE&${qs}`);
    return (data.valueRanges || []).map((v) => v.values || []);
  },
  async update(id, range, values) {
    return call('PUT', `${BASE}/${id}/values/${enc(range)}?valueInputOption=RAW`, { values });
  },
  async append(id, range, values) {
    return call('POST', `${BASE}/${id}/values/${enc(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values });
  },
  async sheetTitles(id) {
    const data = await call('GET', `${BASE}/${id}?fields=sheets.properties.title`);
    return (data.sheets || []).map((s) => s.properties.title);
  },
  async addSheet(id, title) {
    return call('POST', `${BASE}/${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title } } }] });
  },
};
