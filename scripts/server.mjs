import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// 1. Read .dev.vars
const workerEnv = {};
const devVarsPath = path.join(ROOT, '.dev.vars');
if (fs.existsSync(devVarsPath)) {
  for (const line of fs.readFileSync(devVarsPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      workerEnv[k] = v;
    }
  }
}
workerEnv.VOICELAYER_ALLOW_ANY_ORIGIN = 'true';

// 2. Import compiled worker
const workerModule = await import('../dist/_worker.js');
const worker = workerModule.default;

// 3. MIME map
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg'
};

const port = Number(process.env.PORT || 8790);

const srv = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  // Route /api/voice/* to the Hono Cloudflare Worker
  if (u.pathname.startsWith('/api/voice')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuf = Buffer.concat(chunks);
    const webReq = new Request(u.href, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf
    });
    try {
      const webRes = await worker.fetch(webReq, workerEnv);
      const resHeaders = {};
      webRes.headers.forEach((v, k) => { resHeaders[k] = v; });
      resHeaders['access-control-allow-origin'] = origin;
      res.writeHead(webRes.status, resHeaders);
      const ab = await webRes.arrayBuffer();
      res.end(Buffer.from(ab));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files in /public
  let rel = u.pathname === '/' ? '/voicelayer/demo.html' : u.pathname;
  if (!path.extname(rel)) rel += '.html';
  const fp = path.join(PUBLIC, rel);
  if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
});

srv.listen(port, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`  VoiceLayer Host Server is LIVE`);
  console.log(`======================================================`);
  console.log(`  - Local Demo:  http://localhost:${port}/voicelayer/demo.html`);
  console.log(`  - Glass Demo:  http://localhost:${port}/voicelayer/demo-glass-top.html`);
  console.log(`  - Health API:  http://localhost:${port}/api/voice/health`);
  console.log(`  - Grok Brain:  ${workerEnv.XAI_API_KEY ? 'Active (xAI Grok key loaded)' : 'No key'}`);
  console.log(`  - CORS:        Enabled for host apps (e.g. John-wellness-)`);
  console.log(`======================================================\n`);
});
