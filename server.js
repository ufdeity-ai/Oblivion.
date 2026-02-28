import express from 'express';
import { createServer } from 'http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import compression from 'compression';
import { LRUCache } from 'lru-cache';
import { rewriteHTML, rewriteCSS } from './engine.js';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const app = express();

// ── Response cache: cache static assets (JS/CSS/images) up to 50MB total ──────
const cache = new LRUCache({
  maxSize: 50 * 1024 * 1024, // 50 MB
  sizeCalculation: (v) => v.body.length,
  ttl: 1000 * 60 * 5, // 5 min TTL
});

// ── Upstream connection pool via keepAlive dispatcher ─────────────────────────
// Node 18+ built-in fetch uses keepAlive by default with a global dispatcher.
// We set a custom agent via undici if available, else rely on default.
let globalDispatcher;
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  globalDispatcher = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    maxKeepAliveRequests: 0, // unlimited
    connections: 128,
    pipelining: 1,
  });
  setGlobalDispatcher(globalDispatcher);
  console.log('  [Oblivion] Using undici connection pool');
} catch {
  console.log('  [Oblivion] Using built-in fetch (undici not found, that\'s fine)');
}

// ── Gzip compress all text responses sent to client ───────────────────────────
app.use(compression({ threshold: 512 }));

// ── Static files with aggressive browser caching ─────────────────────────────
app.use(express.static(join(__dir, 'static'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
function shouldCache(contentType) {
  return /javascript|text\/css|image\/|font\/|application\/font/.test(contentType);
}

async function decompress(response) {
  const encoding = response.headers.get('content-encoding') || '';
  const buf = Buffer.from(await response.arrayBuffer());
  if (!encoding) return buf;

  return new Promise((resolve, reject) => {
    let stream;
    if (encoding.includes('br'))      stream = createBrotliDecompress();
    else if (encoding.includes('gzip')) stream = createGunzip();
    else if (encoding.includes('deflate')) stream = createInflate();
    else return resolve(buf);

    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.end(buf);
  });
}

// ── Proxy route ───────────────────────────────────────────────────────────────
app.use('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return res.status(400).send('Bad proxy URL');
  }

  // Guard: never proxy back to ourselves (would load Oblivion inside Oblivion)
  const selfOrigin = `${req.protocol}://${req.get('host')}`;
  try {
    const parsed = new URL(targetUrl);
    if (parsed.origin === selfOrigin) {
      return res.status(400).send('<html><body style="background:#04000e;color:#f43f5e;font-family:monospace;padding:40px">Recursive proxy request blocked.</body></html>');
    }
  } catch { /* invalid URL caught below */ }

  const cacheKey = req.method + ':' + targetUrl;

  // Serve from cache for GET requests on cacheable assets
  if (req.method === 'GET') {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.setHeader('content-type', cached.contentType);
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('x-oblivion-cache', 'HIT');
      return res.status(200).send(cached.body);
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000); // 15s timeout

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'accept': req.headers['accept'] || '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'cache-control': 'no-cache',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    const isHTML = contentType.includes('text/html');
    const isCSS  = contentType.includes('text/css');
    const isText = isHTML || isCSS || contentType.includes('text/') || contentType.includes('application/json');

    // Strip blocking headers
    const SKIP = new Set([
      'content-encoding','content-security-policy','x-frame-options',
      'strict-transport-security','cross-origin-embedder-policy',
      'cross-origin-opener-policy','cross-origin-resource-policy',
      'x-content-type-options','content-length','transfer-encoding',
    ]);
    for (const [k, v] of response.headers.entries()) {
      if (!SKIP.has(k.toLowerCase())) res.setHeader(k, v);
    }
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('x-frame-options', 'ALLOWALL');

    const finalUrl = response.url || targetUrl;

    if (isHTML) {
      const raw = await decompress(response);
      const rewritten = rewriteHTML(raw.toString('utf8'), finalUrl);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(response.status).send(rewritten);
    }

    if (isCSS) {
      const raw = await decompress(response);
      const rewritten = rewriteCSS(raw.toString('utf8'), finalUrl);
      res.setHeader('content-type', 'text/css; charset=utf-8');
      if (req.method === 'GET') cache.set(cacheKey, { contentType: 'text/css; charset=utf-8', body: Buffer.from(rewritten) });
      return res.status(response.status).send(rewritten);
    }

    // Binary / other — stream directly without buffering full response
    res.status(response.status);
    if (!isText && response.body) {
      const reader = response.body.getReader();
      const flush = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(Buffer.from(value));
        }
      };
      return flush();
    }

    // Fallback buffer for text/* that isn't HTML/CSS
    const raw = await decompress(response);
    return res.end(raw);

  } catch (err) {
    const timedOut = err.name === 'AbortError';
    console.error(`[Oblivion] ${timedOut ? 'TIMEOUT' : 'FAILED'}: ${targetUrl} — ${err.message}`);
    return res.status(timedOut ? 504 : 500).send(`
      <html><head><meta charset="utf-8"></head>
      <body style="background:#04000e;color:#f0e8ff;font-family:monospace;padding:40px;margin:0">
        <h2 style="color:#a855f7;margin-bottom:16px">${timedOut ? 'Request Timed Out' : 'Connection Failed'}</h2>
        <p style="color:#f43f5e;margin-bottom:12px">${err.message}</p>
        <p style="opacity:0.4;font-size:0.85rem">→ ${targetUrl}</p>
      </body></html>`);
  }
});

// ── ARIA AI proxy ─────────────────────────────────────────────────────────────
// Forwards requests to Anthropic so the API key stays server-side.
// Key priority: env ANTHROPIC_API_KEY → request header x-aria-key (user-supplied)
app.use('/api/chat', express.json({ limit: '1mb' }), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || req.headers['x-aria-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'no_key',
      message: 'No API key configured. Set ANTHROPIC_API_KEY on the server, or enter your key in ARIA settings.',
    });
  }

  try {
    const { messages, system } = req.body;
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system,
        messages,
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'upstream_error', message: data?.error?.message || 'Anthropic API error' });
    }
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── Frontend ──────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(join(__dir, 'static', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 80;
createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✦ Oblivion — Void Engine → http://localhost:${PORT}\n`);
});
