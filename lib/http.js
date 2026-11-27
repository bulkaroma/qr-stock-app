import crypto from 'node:crypto';
import { config } from './config.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function pinOk(given) {
  if (!config.pin) return true;
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(config.pin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  return {};
}

/** Wrap a handler: method check, PIN check, JSON body, JSON errors. */
export function api(methods, fn, { public: isPublic = false } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!methods.includes(req.method)) throw new ApiError(405, 'Method not allowed');
      if (!isPublic && !pinOk(req.headers['x-app-pin'])) throw new ApiError(401, 'Wrong or missing PIN');
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await fn({ req, body, query: req.query || {} });
      res.status(200).json(out);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message || 'Server error' });
    }
  };
}
