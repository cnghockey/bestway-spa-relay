'use strict';
// One-time bind: create an anonymous "visitor", bind your spa via a Share-Device QR
// code, and write ../.spa_config.json. Node port of the setup flow from
// epheterson/bestway-spa-v2 — all credit there for the protocol.
//
// In the Bestway app: tap ... on your spa -> "Share The Device" -> scan the QR with
// your phone camera -> copy the text starting with RW_Share_ -> paste it here.
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const APPID = 'AhFLL54HnChhrxcl9ZUJL6QNfolTIB';
const APPSECRET = '4ECvVs13enL5AiYSmscNjvlaisklQDz7vWPCCWXcEFjhWfTmLT';
const HOSTS = { EU: 'smarthub-eu.bestwaycorp.com', US: 'smarthub-us.bestwaycorp.com', CN: 'smarthub.bestwaycorp.cn' };

let HOST;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex').toUpperCase();
function hdrs(token, pushtype = 'fcm') {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = String(Math.floor(Date.now() / 1000));
  return { pushtype, appid: APPID, nonce, ts, 'accept-language': 'en', sign: md5(APPID + APPSECRET + nonce + ts), Authorization: token ? `token ${token}` : 'token', 'Content-Type': 'application/json; charset=UTF-8' };
}
function call(method, p, headers, bodyObj) {
  const body = bodyObj != null ? Buffer.from(JSON.stringify(bodyObj)) : null;
  const opts = { host: HOST, path: p, method, headers: { ...headers, Host: HOST }, rejectUnauthorized: false, timeout: 20000 };
  if (body) opts.headers['Content-Length'] = body.length;
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 120)}`)); } }); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body) r.write(body); r.end();
  });
}
const ask = (rl, q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const region = ((await ask(rl, 'Region [EU/US/CN] (US): ')) || 'US').toUpperCase();
  if (!HOSTS[region]) { console.error('Unknown region'); process.exit(1); }
  HOST = HOSTS[region];

  const visitor_id = crypto.randomBytes(8).toString('hex');
  const auth = await call('POST', '/api/enduser/visitor', hdrs(null), {
    app_id: APPID, brand: '', lan_code: 'en', location: 'GB', marketing_notification: 0,
    push_type: 'fcm', timezone: 'GMT', visitor_id, registration_id: '', client_id: crypto.randomBytes(8).toString('hex').slice(0, 15),
  });
  const token = auth && auth.data && auth.data.token;
  if (!token) { console.error('Auth failed:', JSON.stringify(auth)); process.exit(1); }
  console.log('visitor registered.');

  const qr = await ask(rl, 'Paste the RW_Share_... QR text: ');
  rl.close();
  if (!qr.startsWith('RW_Share_')) { console.error('That does not look like a Share-Device code.'); process.exit(1); }

  const bind = await call('POST', '/api/enduser/grant_device', hdrs(token, 'android'), { vercode: qr, push_type: 'android' });
  if (bind && bind.code !== 0) console.log('grant_device note:', JSON.stringify(bind).slice(0, 160));

  // discover the bound device to get product_id + name
  let device_id = qr.split('_')[3] || '', product_id = '', device_name = 'Hot Tub';
  const homes = await call('GET', '/api/enduser/homes', hdrs(token));
  for (const home of ((homes.data || {}).list || [])) {
    const rooms = await call('GET', `/api/enduser/home/rooms?home_id=${home.id}`, hdrs(token));
    for (const room of ((rooms.data || {}).list || [])) {
      const devs = await call('GET', `/api/enduser/home/room/devices?room_id=${room.id}`, hdrs(token));
      for (const dev of ((devs.data || {}).list || [])) {
        if (!device_id || dev.device_id === device_id) {
          device_id = dev.device_id || device_id; product_id = dev.product_id || product_id;
          device_name = dev.dev_name || dev.name || device_name;
        }
      }
    }
  }
  if (!product_id) { console.error('Bound, but could not discover product_id — check the app / try again.'); process.exit(1); }

  const cfg = { region, visitor_id, device_id, device_name, product_id };
  const out = path.join(__dirname, '..', '.spa_config.json');
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n'); fs.chmodSync(out, 0o600);
  console.log(`Bound "${device_name}" -> ${out}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
