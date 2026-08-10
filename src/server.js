'use strict';
// Bestway spa -> HTTP relay + self-hosted Google Smart Home integration. Zero npm deps.
//   /cmd/status                         current spa state (JSON)
//   /cmd/set?token=..&heat=on|off&jets=on|off&filter=on|off&power=on|off&temp=<C>
//   /oauth/authorize  /oauth/token  /smarthome   (Google account-linking + fulfillment)
//   /health
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sh = require('./smarthome');

(() => { try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/\r$/, '');
  }
} catch { /* rely on real env */ } })();

let bestway;
try { bestway = require('./bestway'); } catch (e) { console.error('FATAL: cannot load spa config — run `node src/setup.js` first.', e.message); process.exit(1); }
bestway.startWarmup();

const CFG = { secret: process.env.RELAY_SECRET, port: +(process.env.RELAY_PORT || 3301) };
if (!CFG.secret) { console.error('FATAL: missing env RELAY_SECRET'); process.exit(1); }
const GH = { clientId: process.env.GH_CLIENT_ID || 'spa-google', clientSecret: process.env.GH_CLIENT_SECRET || CFG.secret, linkSecret: process.env.GH_LINK_SECRET || CFG.secret };

const log = (...a) => console.log(new Date().toISOString(), ...a);
function authed(req, url) {
  const tok = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-relay-token'] || '';
  const a = Buffer.from(tok), b = Buffer.from(CFG.secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => r(b)); });

async function doSet(params) {
  const out = {};
  const onoff = (v) => /^(on|1|true)$/i.test(v);
  if (params.has('heat')) out.heat = await bestway.heat(onoff(params.get('heat')));
  if (params.has('jets')) out.jets = await bestway.jets(onoff(params.get('jets')));
  if (params.has('filter')) out.filter = await bestway.filter(onoff(params.get('filter')));
  if (params.has('power')) out.power = await bestway.power(onoff(params.get('power')));
  if (params.has('temp')) out.temp = await bestway.setTempC(Number(params.get('temp')));
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname === '/oauth/authorize') return sh.authorize(req, res, url, req.method === 'POST' ? Object.fromEntries(new URLSearchParams(await readBody(req))) : {}, GH);
    if (url.pathname === '/oauth/token' && req.method === 'POST') return sh.token(req, res, Object.fromEntries(new URLSearchParams(await readBody(req))), GH);
    if (url.pathname === '/smarthome' && req.method === 'POST') return sh.fulfillment(req, res, await readBody(req), { bestway });
    if (url.pathname === '/cmd/status') { if (!authed(req, url)) return json(403, { ok: false }); return json(200, { ok: true, state: bestway.view(await bestway.status(0)) }); }
    if (url.pathname === '/cmd/set') { if (!authed(req, url)) return json(403, { ok: false }); const r = await doSet(url.searchParams); log('set', JSON.stringify([...url.searchParams].filter(([k]) => k !== 'token'))); return json(200, { ok: true, applied: r }); }
    return json(404, { ok: false, error: 'not found' });
  } catch (e) { log('ERR', e.message); return json(500, { ok: false, error: e.message }); }
});
server.listen(CFG.port, '127.0.0.1', () => log(`spa relay on 127.0.0.1:${CFG.port} (device: ${bestway.name})`));
