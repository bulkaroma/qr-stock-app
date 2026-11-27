// Local test server that behaves like Vercel: serves /public and runs /api/*.js.
//   npm run dev          -> uses your real Google Sheets (needs .env)
//   npm run dev:mock     -> uses built-in sample data, no Google needed
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env (KEY=value per line; values may be wrapped in single or double quotes)
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
}

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function vercelRes(res) {
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__mock/book' && process.env.MOCK_SHEETS === '1') {
    const { mockBackend } = await import('./mock-sheets.js');
    return vercelRes(res).status(200).json(mockBackend.book);
  }
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
    const file = path.join(root, 'api', `${name}.js`);
    if (!fs.existsSync(file)) return vercelRes(res).status(404).json({ error: 'Not found' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.query = Object.fromEntries(url.searchParams);
    req.body = raw && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : raw || undefined;
    const mod = await import(pathToFileURL(file).href);
    return mod.default(req, vercelRes(res));
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = path.join(root, 'public', path.normalize(p));
  if (!file.startsWith(path.join(root, 'public'))) return res.writeHead(403).end();
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end('Not found');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`QR stock app on http://localhost:${port}${process.env.MOCK_SHEETS === '1' ? '  (sample data, not your real sheets)' : ''}`);
});
