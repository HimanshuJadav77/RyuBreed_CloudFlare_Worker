import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import worker from './worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .dev.vars
const env = {};
const devVarsPath = path.resolve(__dirname, '.dev.vars');
if (fs.existsSync(devVarsPath)) {
  const content = fs.readFileSync(devVarsPath, 'utf8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  });
}

const PORT = Number(process.env.PORT) || 8787;

const server = http.createServer(async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = new URL(req.url, `${protocol}://${host}`);

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer;

    const webHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) webHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
    }

    const webReq = new Request(url.toString(), {
      method: req.method,
      headers: webHeaders,
      body,
    });

    const ctx = {
      waitUntil: (promise) => promise.catch(console.error),
    };

    const webRes = await worker.fetch(webReq, env, ctx);

    res.statusCode = webRes.status;
    webRes.headers.forEach((val, key) => {
      res.setHeader(key, val);
    });

    const resArrayBuffer = await webRes.arrayBuffer();
    res.end(Buffer.from(resArrayBuffer));
  } catch (err) {
    console.error('[Worker Dev Server Error]:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Cloudflare Worker Dev Server] Running at http://127.0.0.1:${PORT} (Zero-Wrangler local runner)`);
});

