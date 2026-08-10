'use strict';
// Google Smart Home "cloud-to-cloud" bridge for the Bestway spa: minimal OAuth2
// account linking (gated by GH_LINK_SECRET) + SYNC/QUERY/EXECUTE fulfillment.
// Devices: Hot Tub (canonical THERMOSTAT), Hot Tub Jets, Hot Tub Filter (switches).
// See LESSONS.md for why THERMOSTAT (not WATER_HEATER) and why QUERY must be fast.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AGENT_USER_ID = 'spa-user';
const TOKENS_FILE = process.env.GH_TOKENS_FILE || path.join(__dirname, '..', 'gh-tokens.json');
const RESPOND_MS = +(process.env.GH_RESPOND_MS || 1800);
const raceFire = (p) => Promise.race([p.then((v) => ({ done: true, v })), new Promise((r) => setTimeout(() => r({ done: false }), RESPOND_MS))]);

const DEVICES = {
  hottub: {
    kind: 'thermostat',
    type: 'action.devices.types.THERMOSTAT',
    traits: ['action.devices.traits.TemperatureSetting'],
    name: { name: 'Hot Tub', nicknames: ['the spa'] },
    attributes: { availableThermostatModes: ['off', 'heat'], thermostatTemperatureUnit: 'C' },
  },
  hottub_jets: { kind: 'onoff', bwKey: 'jets', type: 'action.devices.types.SWITCH', traits: ['action.devices.traits.OnOff'], name: { name: 'Hot Tub Jets', nicknames: ['hot tub bubbles'] } },
  hottub_filter: { kind: 'onoff', bwKey: 'filter', type: 'action.devices.types.SWITCH', traits: ['action.devices.traits.OnOff'], name: { name: 'Hot Tub Filter', nicknames: ['hot tub pump'] } },
};

function loadTokens() { try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return { access: {}, refresh: {}, codes: {} }; } }
function saveTokens(t) { try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t)); fs.chmodSync(TOKENS_FILE, 0o600); } catch (e) { console.error('token save', e.message); } }
let TOK = loadTokens();
const rnd = () => crypto.randomBytes(24).toString('base64url');
const now = () => Date.now();
function bearerValid(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i); if (!m) return false;
  for (const a in TOK.access) if (TOK.access[a].exp < now()) delete TOK.access[a];
  const e = TOK.access[m[1]]; return !!(e && e.exp > now());
}
function htmlLogin(q, err) {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:24rem;margin:3rem auto;padding:0 1rem">
<h2>Link spa to Google</h2>${err ? `<p style="color:#c00">${err}</p>` : ''}
<form method="POST"><input type=hidden name=client_id value="${q.client_id || ''}">
<input type=hidden name=redirect_uri value="${q.redirect_uri || ''}"><input type=hidden name=state value="${q.state || ''}">
<p><input name=secret type=password placeholder="Link secret" autofocus style="width:100%;padding:.6rem;font-size:1rem"></p>
<button style="width:100%;padding:.6rem;font-size:1rem">Authorize</button></form></body>`;
}
function authorize(req, res, url, form, cfg) {
  const q = req.method === 'POST' ? form : Object.fromEntries(url.searchParams);
  if (q.client_id !== cfg.clientId) { res.writeHead(400).end('bad client_id'); return; }
  if (!/^https:\/\/oauth-redirect(-sandbox)?\.googleusercontent\.com\//.test(q.redirect_uri || '')) { res.writeHead(400).end('bad redirect_uri'); return; }
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(htmlLogin(q)); return; }
  const a = Buffer.from(q.secret || ''), b = Buffer.from(cfg.linkSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(htmlLogin(q, 'Wrong secret')); return; }
  const code = rnd(); TOK.codes[code] = { exp: now() + 6e5 }; saveTokens(TOK);
  const to = new URL(q.redirect_uri); to.searchParams.set('code', code); if (q.state) to.searchParams.set('state', q.state);
  res.writeHead(302, { location: to.toString() }); res.end();
}
function token(req, res, form, cfg) {
  const send = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (form.client_id !== cfg.clientId || form.client_secret !== cfg.clientSecret) return send({ error: 'invalid_client' }, 400);
  if (form.grant_type === 'authorization_code') {
    const c = TOK.codes[form.code]; if (!c || c.exp < now()) return send({ error: 'invalid_grant' }, 400);
    delete TOK.codes[form.code]; const access = rnd(), refresh = rnd();
    TOK.access[access] = { exp: now() + 36e5 }; TOK.refresh[refresh] = 1; saveTokens(TOK);
    return send({ token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600 });
  }
  if (form.grant_type === 'refresh_token') {
    if (!TOK.refresh[form.refresh_token]) return send({ error: 'invalid_grant' }, 400);
    const access = rnd(); TOK.access[access] = { exp: now() + 36e5 }; saveTokens(TOK);
    return send({ token_type: 'Bearer', access_token: access, expires_in: 3600 });
  }
  return send({ error: 'unsupported_grant_type' }, 400);
}

async function fulfillment(req, res, body, ctx) {
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!bearerValid(req)) { res.writeHead(401).end('{"error":"unauthorized"}'); return; }
  let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
  const requestId = msg.requestId;
  const intent = msg.inputs && msg.inputs[0] && msg.inputs[0].intent;

  if (intent === 'action.devices.SYNC') {
    return send({ requestId, payload: { agentUserId: AGENT_USER_ID, devices: Object.entries(DEVICES).map(([id, d]) => ({
      id, type: d.type, traits: d.traits, name: d.name, willReportState: false,
      ...(d.attributes ? { attributes: d.attributes } : {}),
      deviceInfo: { manufacturer: 'bestway-spa-google', model: 'AIRJET' },
    })) } });
  }
  if (intent === 'action.devices.QUERY') {
    const devices = {};
    let bw = null; try { bw = await ctx.bestway.quickView(); } catch (e) { console.error('bestway quickView', e.message); }
    for (const q of msg.inputs[0].payload.devices) {
      const d = DEVICES[q.id];
      if (!d || !bw) { devices[q.id] = { online: false, status: 'ERROR' }; continue; }
      if (d.kind === 'thermostat') devices[q.id] = { status: 'SUCCESS', online: bw.online, thermostatMode: bw.heating ? 'heat' : 'off', thermostatTemperatureSetpoint: bw.targetC, thermostatTemperatureAmbient: bw.waterC };
      else devices[q.id] = { status: 'SUCCESS', online: bw.online, on: d.bwKey === 'jets' ? bw.jets : bw.filter };
    }
    return send({ requestId, payload: { devices } });
  }
  if (intent === 'action.devices.EXECUTE') {
    const results = [];
    for (const cmd of msg.inputs[0].payload.commands) for (const dev of cmd.devices) {
      const d = DEVICES[dev.id];
      if (!d) { results.push({ ids: [dev.id], status: 'ERROR', errorCode: 'deviceNotFound' }); continue; }
      try {
        const states = { online: true };
        for (const ex of cmd.execution) {
          let fire = null, apply = null, label = '';
          const c = ex.command;
          if (c === 'action.devices.commands.OnOff') { const on = !!ex.params.on; fire = () => ctx.bestway[d.bwKey](on); apply = () => { states.on = on; }; label = `${d.bwKey} ${on ? 'on' : 'off'}`; }
          else if (c === 'action.devices.commands.ThermostatSetMode') { const on = ex.params.thermostatMode === 'heat'; fire = () => ctx.bestway.heat(on); apply = () => { states.thermostatMode = ex.params.thermostatMode; }; label = `mode ${ex.params.thermostatMode}`; }
          else if (c === 'action.devices.commands.ThermostatTemperatureSetpoint') { const t = Math.round(ex.params.thermostatTemperatureSetpoint); fire = () => ctx.bestway.setTempC(t); apply = () => { states.thermostatTemperatureSetpoint = t; }; label = `temp ${t}C`; }
          if (!fire) continue;
          const codeP = Promise.resolve().then(fire).then(() => '000000').then((code) => { console.log(new Date().toISOString(), 'EXECUTE', dev.id, label, '->', code); return code; }).catch((e) => { console.error('EXECUTE', dev.id, label, e.message); return 'EXC'; });
          const race = await raceFire(codeP);
          if (race.done && race.v !== '000000') throw new Error('cmd ' + race.v);
          apply();
        }
        results.push({ ids: [dev.id], status: 'SUCCESS', states });
      } catch (e) { console.error('EXECUTE', dev.id, e.message); results.push({ ids: [dev.id], status: 'ERROR', errorCode: 'transientError' }); }
    }
    return send({ requestId, payload: { commands: results } });
  }
  if (intent === 'action.devices.DISCONNECT') return send({});
  return send({ requestId, payload: { errorCode: 'notSupported' } });
}

module.exports = { authorize, token, fulfillment, DEVICES };
