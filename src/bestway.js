'use strict';
// Bestway SmartSpa (V02 / AIRJET) runtime client — a Node port of the protocol from
// epheterson/bestway-spa-v2 (Python). Full credit to that project for reverse-
// engineering the SmartHub AWS API (anonymous "visitor" auth, AES-256-CBC v2
// commands, the APPID/APPSECRET/IV constants, and the QR "Share Device" bind flow):
//   https://github.com/epheterson/bestway-spa-v2
// This port adds a persistent Node service + a Google Smart Home bridge.
//
// Config comes from ./.spa_config.json (or $BESTWAY_CONFIG), produced by `setup.js`.
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APPID = 'AhFLL54HnChhrxcl9ZUJL6QNfolTIB';
const APPSECRET = '4ECvVs13enL5AiYSmscNjvlaisklQDz7vWPCCWXcEFjhWfTmLT';
const HOSTS = { EU: 'smarthub-eu.bestwaycorp.com', US: 'smarthub-us.bestwaycorp.com', CN: 'smarthub.bestwaycorp.cn' };
const FIXED_IV = Buffer.from([56, 110, 58, 168, 76, 255, 94, 159, 237, 215, 171, 181, 150, 40, 74, 166]);
const TEMP_MIN_C = 20, TEMP_MAX_C = 40;

const cfg = JSON.parse(fs.readFileSync(process.env.BESTWAY_CONFIG || path.join(__dirname, '..', '.spa_config.json'), 'utf8'));
const HOST = HOSTS[cfg.region || 'US'];

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex').toUpperCase();
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function sign() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = String(Math.floor(Date.now() / 1000));
  return { nonce, ts, sign: md5(APPID + APPSECRET + nonce + ts) };
}
function headers(token) {
  const s = sign();
  return { h: {
    pushtype: 'fcm', appid: APPID, nonce: s.nonce, ts: s.ts, 'accept-language': 'en',
    sign: s.sign, Authorization: token ? `token ${token}` : 'token',
    'User-Agent': 'okhttp/4.9.0', 'Content-Type': 'application/json; charset=UTF-8',
  }, sign: s.sign };
}
function req(method, p, hdrs, bodyObj) {
  const body = bodyObj != null ? Buffer.from(JSON.stringify(bodyObj)) : null;
  const opts = { host: HOST, path: p, method, headers: { ...hdrs, Host: HOST }, rejectUnauthorized: false, timeout: 15000 };
  if (body) opts.headers['Content-Length'] = body.length;
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`non-JSON HTTP ${res.statusCode}: ${d.slice(0, 120)}`)); } }); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body) r.write(body); r.end();
  });
}

let _tok = null, _tokAt = 0;
async function token() {
  if (_tok && Date.now() - _tokAt < 60 * 60 * 1000) return _tok;
  const { h } = headers(null);
  const res = await req('POST', '/api/enduser/visitor', h, {
    app_id: APPID, brand: '', lan_code: 'en', location: 'GB', marketing_notification: 0,
    push_type: 'fcm', timezone: 'GMT', visitor_id: cfg.visitor_id, registration_id: '',
    client_id: crypto.randomBytes(8).toString('hex').slice(0, 15),
  });
  const t = res && res.data && res.data.token;
  if (!t) throw new Error('bestway auth failed: ' + JSON.stringify(res && res.code));
  _tok = t; _tokAt = Date.now(); return t;
}

let _state = null, _stateAt = 0;
async function status(maxAgeMs = 8000) {
  if (_state && Date.now() - _stateAt < maxAgeMs) return _state;
  const t = await token();
  const { h } = headers(t);
  const res = await req('POST', '/api/device/thing_shadow/', h, { device_id: cfg.device_id, product_id: cfg.product_id });
  const data = (res && res.data) || {};
  const st = (data.state && (data.state.reported || data.state.desired)) || data.state || data;
  _state = st; _stateAt = Date.now(); return st;
}

function encrypt(signHex, plaintext) {
  const key = Buffer.from(sha256hex(`${signHex},${APPSECRET}`).slice(0, 32), 'utf8'); // 32 bytes -> AES-256
  const c = crypto.createCipheriv('aes-256-cbc', key, FIXED_IV);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([FIXED_IV, ct]).toString('base64');
}
async function set(key, value) {
  const t = await token();
  const { h, sign: signHex } = headers(t);
  const plaintext = JSON.stringify({ device_id: cfg.device_id, product_id: cfg.product_id, desired: JSON.stringify({ state: { desired: { [key]: value } } }) });
  let res = await req('POST', '/api/v2/device/command', h, { encrypted_data: encrypt(signHex, plaintext) });
  if (!res || res.code !== 0) { const { h: h2 } = headers(t); res = await req('POST', '/api/device/command/', h2, { device_id: cfg.device_id, product_id: cfg.product_id, desired: { state: { desired: { [key]: value } } } }); }
  _state = null;
  if (!res || res.code !== 0) throw new Error('bestway cmd ' + (res && res.code));
  return true;
}

function viewOf(st) {
  return {
    online: !!(st && st.is_online), power: !!(st && st.power_state),
    heating: !!(st && st.heater_state), jets: !!(st && st.wave_state), filter: !!(st && st.filter_state),
    unitC: !st || st.temperature_unit === 1,
    waterC: st ? Number(st.water_temperature) : null, targetC: st ? Number(st.temperature_setting) : null,
  };
}
// Fast view for Google QUERY: cached instantly (bg refresh if stale); a cold cache
// gives up after waitMs with a safe "online" default so linking never times out.
async function quickView(waitMs = 1500) {
  if (_state) { if (Date.now() - _stateAt > 20000) status(0).catch(() => {}); return viewOf(_state); }
  const race = await Promise.race([status(0).then((s) => ({ s })).catch(() => ({ s: null })), new Promise((r) => setTimeout(() => r({ timeout: true }), waitMs))]);
  if (race.s) return viewOf(race.s);
  status(0).catch(() => {});
  return { online: true, power: false, heating: false, jets: false, filter: false, unitC: true, waterC: null, targetC: null };
}
function startWarmup() { status(0).catch(() => {}); setInterval(() => status(0).catch(() => {}), 60000).unref(); }

const clampC = (c) => Math.max(TEMP_MIN_C, Math.min(TEMP_MAX_C, Math.round(c)));
module.exports = {
  name: cfg.device_name || 'Hot Tub',
  status, quickView, startWarmup, view: viewOf,
  heat: (on) => set('heater_state', on ? 1 : 0),
  jets: (on) => set('wave_state', on ? 1 : 0),
  filter: (on) => set('filter_state', on ? 1 : 0),
  power: (on) => set('power_state', on ? 1 : 0),
  setTempC: (c) => set('temperature_setting', clampC(c)),
};
