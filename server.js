import express from 'express';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, createInflate, createBrotliDecompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const __dir = fileURLToPath(new URL('.', import.meta.url));
const app = express();

// ── Simple in-memory cache (replaces lru-cache package) ──────────────────────
class SimpleCache {
  constructor(maxBytes = 50 * 1024 * 1024, ttlMs = 5 * 60 * 1000) {
    this.maxBytes = maxBytes; this.ttlMs = ttlMs;
    this.map = new Map(); this.currentBytes = 0;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > this.ttlMs) { this._del(key); return null; }
    return e;
  }
  set(key, contentType, body) {
    if (this.map.has(key)) this._del(key);
    while (this.currentBytes + body.length > this.maxBytes && this.map.size > 0)
      this._del(this.map.keys().next().value);
    this.map.set(key, { contentType, body, ts: Date.now() });
    this.currentBytes += body.length;
  }
  _del(key) {
    const e = this.map.get(key);
    if (e) { this.currentBytes -= e.body.length; this.map.delete(key); }
  }
}
const cache = new SimpleCache();

// ── Built-in gzip compression (replaces compression package) ─────────────────
app.use((req, res, next) => {
  const origSend = res.send.bind(res);
  res.send = async function(body) {
    const ct = String(res.getHeader('content-type') || '');
    const ae = String(req.headers['accept-encoding'] || '');
    const isText = /text\/|javascript|json|xml/.test(ct);
    const size = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body));
    if (isText && ae.includes('gzip') && size > 512 && !res.getHeader('content-encoding')) {
      try {
        const buf = await gzipAsync(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-length', buf.length);
        return origSend(buf);
      } catch {}
    }
    return origSend(body);
  };
  next();
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(join(__dir, 'static'), { maxAge: '1d', etag: true }));

// ── Decompress upstream response ──────────────────────────────────────────────
async function decompress(response) {
  const enc = response.headers.get('content-encoding') || '';
  const ab = await response.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!enc || enc === 'identity') return buf;
  return new Promise((resolve, reject) => {
    let s;
    const lowEnc = enc.toLowerCase();
    if (lowEnc.includes('br'))       s = createBrotliDecompress();
    else if (lowEnc.includes('gzip')) s = createGunzip();
    else if (lowEnc.includes('deflate')) s = createInflate();
    else return resolve(buf);
    const chunks = [];
    s.on('data', c => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', (err) => {
      console.error(`Decompression error (${enc}):`, err);
      resolve(buf); // Fallback to raw buffer if decompression fails
    });
    s.end(buf);
  });
}

// ── Proxy route ───────────────────────────────────────────────────────────────
app.use('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.startsWith('http')) return res.status(400).send('Bad proxy URL');

  // Prevent recursive proxy
  try {
    if (new URL(targetUrl).origin === `${req.protocol}://${req.get('host')}`)
      return res.status(400).send('<html><body style="background:#04000e;color:#f43f5e;padding:40px;font-family:monospace">Recursive proxy blocked.</body></html>');
  } catch {}

  const cacheKey = req.method + ':' + targetUrl;
  if (req.method === 'GET') {
    const hit = cache.get(cacheKey);
    if (hit) {
      res.setHeader('content-type', hit.contentType);
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('x-oblivion-cache', 'HIT');
      return res.send(hit.body);
    }
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept': req.headers['accept'] || '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'cache-control': 'no-cache',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(t);

    const ct = response.headers.get('content-type') || '';
    const isHTML = ct.includes('text/html');
    const isCSS  = ct.includes('text/css');
    const isText = isHTML || isCSS || ct.includes('text/') || ct.includes('application/json');

    const SKIP = new Set(['content-encoding','content-security-policy','x-frame-options',
      'strict-transport-security','cross-origin-embedder-policy','cross-origin-opener-policy',
      'cross-origin-resource-policy','x-content-type-options','content-length','transfer-encoding']);
    for (const [k, v] of response.headers.entries()) if (!SKIP.has(k.toLowerCase())) res.setHeader(k, v);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('x-frame-options', 'ALLOWALL');

    const finalUrl = response.url || targetUrl;

    if (isHTML) {
      const raw = await decompress(response);
      let out = raw.toString('utf8');
      try { const { rewriteHTML } = await import('./engine.js'); out = rewriteHTML(out, finalUrl); } catch {}
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(response.status).send(out);
    }
    if (isCSS) {
      const raw = await decompress(response);
      let out = raw.toString('utf8');
      try { const { rewriteCSS } = await import('./engine.js'); out = rewriteCSS(out, finalUrl); } catch {}
      res.setHeader('content-type', 'text/css; charset=utf-8');
      if (req.method === 'GET') cache.set(cacheKey, 'text/css; charset=utf-8', Buffer.from(out));
      return res.status(response.status).send(out);
    }

    res.status(response.status);
    if (!isText && response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(Buffer.from(value));
      }
      return;
    }
    return res.end(await decompress(response));

  } catch (err) {
    const to = err.name === 'AbortError';
    return res.status(to ? 504 : 500).send(`<html><body style="background:#04000e;color:#f0e8ff;font-family:monospace;padding:40px">
      <h2 style="color:#a855f7">${to ? 'Timed Out' : 'Failed'}</h2>
      <p style="color:#f43f5e">${err.message}</p>
      <p style="opacity:0.4">→ ${targetUrl}</p></body></html>`);
  }
});

// ── ARIA AI proxy — keeps API key server-side ─────────────────────────────────
app.use('/api/chat', express.json({ limit: '1mb' }), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || req.headers['x-aria-key'];
  if (!apiKey) return res.status(401).json({ error: 'no_key', message: 'No API key configured.' });

  try {
    const { messages = [], system = '' } = req.body || {};
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system, messages }),
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'upstream_error', message: data?.error?.message || 'API error' });
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── Frontend ──────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(join(__dir, 'static', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 5000;
createServer(app).listen(PORT, '0.0.0.0', () =>
  console.log(`\n  ✦ VoidOS — Void Engine → http://localhost:${PORT}\n`));
