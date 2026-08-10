# bestway-spa-relay

Control a **Bestway SmartSpa / Lay-Z-Spa** (AIRJET "V02" models — the ones that pair with the **Bestway** / SmartSpa app) from your smart-home setup — **Home Assistant, Homebridge, a voice assistant, an AI agent, or a plain `curl`**. A zero-dependency Node relay that exposes your spa as a small **token-gated HTTP API** (and, optionally, as native smart-home devices) on top of a port of the SmartHub cloud protocol.

```
Home Assistant / Homebridge / a voice assistant / curl / your agent
        ->  this relay (your server)  ->  Bestway SmartHub (AWS) cloud  ->  your spa
   e.g.  curl "https://you.example.com/cmd/set?token=...&temp=38"
```

## Credit
The Bestway/SmartHub protocol here — anonymous "visitor" auth, AES-256-CBC v2 commands, the app constants, and the QR **Share-Device** bind flow — was reverse-engineered by **[epheterson/bestway-spa-v2](https://github.com/epheterson/bestway-spa-v2)** (Python). This project is a **Node port of that runtime** plus a **smart-home bridge** — a token-gated HTTP API (Home Assistant, Homebridge, …) and an optional native cloud integration — which the original doesn't include. If you just want a CLI, use theirs; if you want it in your smart home, use this. 🙏

## ⚠️ Notes
- Talks to Bestway's cloud with an anonymous visitor bound to **your** spa via a QR code you generate — for interoperability with hardware you own. May break when Bestway changes their app/API.
- Not affiliated with Bestway.

## Quick start
```bash
git clone https://github.com/cnghockey/bestway-spa-relay
cd bestway-spa-relay
cp .env.example .env && chmod 600 .env     # set RELAY_SECRET (+ GH_* for the optional cloud bridge)

npm run setup      # one-time: pick region, paste a Share-Device QR -> writes .spa_config.json
npm start          # no deps to install
curl "http://127.0.0.1:3301/cmd/status?token=$RELAY_SECRET"
```

### The one-time `setup`
In the **Bestway** app: tap `...` on your spa → **Share The Device** → a QR code appears → **scan it with your phone camera** (not the app) → copy the text starting with `RW_Share_`. Run `npm run setup`, choose your region (EU/US/CN), paste that text. It binds an anonymous visitor to your spa and writes `.spa_config.json`. Sharing supports multiple controllers, so **binding this does not log your phone app out**.

## HTTP API (for testing / your own automations)
```
GET /cmd/status?token=SECRET
GET /cmd/set?token=SECRET&heat=on            # heater on/off
GET /cmd/set?token=SECRET&temp=38            # target °C (clamped 20–40)
GET /cmd/set?token=SECRET&jets=on&filter=off # bubbles / filter pump
```
Binds `127.0.0.1` — front it with a TLS reverse proxy if exposing.

## Connect it to your smart home
The relay is just the **token-gated HTTP API** above, so it drops into anything.

### Home Assistant (recommended — one integration, every ecosystem)
Point Home Assistant at the HTTP API and inherit everything HA already bridges to (voice assistants, dashboards, HomeKit, automations). In `configuration.yaml`:
```yaml
rest_command:
  spa_heat_on:  { url: "https://you.example.com/cmd/set?token=YOUR_RELAY_SECRET&heat=on" }
  spa_heat_off: { url: "https://you.example.com/cmd/set?token=YOUR_RELAY_SECRET&heat=off" }
  spa_jets_on:  { url: "https://you.example.com/cmd/set?token=YOUR_RELAY_SECRET&jets=on" }
  spa_jets_off: { url: "https://you.example.com/cmd/set?token=YOUR_RELAY_SECRET&jets=off" }
  spa_set_temp: { url: "https://you.example.com/cmd/set?token=YOUR_RELAY_SECRET&temp={{ temp }}" }
```
Drive `spa_set_temp` from a `number`/`climate` template, wrap the rest in switches, and expose to whatever assistant you use.

### Homebridge / Node-RED / IFTTT / shell / AI agents
Anything that can make an HTTP request works.

### Native cloud integration (optional, built-in)
For an assistant that wants native devices without going through Home Assistant, the relay ships a self-hosted **cloud-to-cloud** integration. Devices: **Hot Tub** (a `THERMOSTAT` — heat/off + °C setpoint), **Hot Tub Jets**, **Hot Tub Filter** (switches).

> You invent `GH_CLIENT_ID` / `GH_CLIENT_SECRET` / `GH_LINK_SECRET` yourself (no third party): set them in `.env` and enter the same in your assistant's developer console.

Put the relay behind HTTPS, register a cloud-to-cloud integration (Authorization `…/oauth/authorize`, Token `…/oauth/token`, Fulfillment `…/smarthome`), link with `GH_LINK_SECRET`. Modeled as a `THERMOSTAT`, **not** a `WATER_HEATER` (rejected at link time), and QUERY is served from a warm cache so linking (which must answer in ~5 s) never times out. See **[LESSONS.md](LESSONS.md)**.

## Security
- `.env`, `.spa_config.json`, `gh-tokens.json` hold secrets/identifiers — `chmod 600`, never commit (gitignored).
- Gate `/cmd/*` with a long random `RELAY_SECRET`.

## Support / donate
Yes, we reverse-engineered a hot-tub cloud so a robot could warm the water on command. We're at peace with it.

If you benefited from this and have a few sats to spare, you can send them to:

⚡ **`sats4ai@blink.sv`**

(It's a **Bitcoin Lightning** address — pay it from any Lightning wallet. Looks like an email, isn't one. Lightning only: no on-chain, no fiat, no refunds on gratitude.)

And consider visiting our site — more services for you and/or your clanker (yes, agents can pay for their own tools now): **[sats4ai.com](https://sats4ai.com)** — pay-per-call AI tools for Bitcoin, no signup.

_MIT licensed. Not affiliated with Bestway. Protocol credit: [epheterson/bestway-spa-v2](https://github.com/epheterson/bestway-spa-v2)._
