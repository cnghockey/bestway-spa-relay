# Lessons: a Bestway spa on Google Home

Notes from porting the runtime and wiring it to Google — mostly Google Smart Home gotchas, which are the same whatever the backend.

## Bestway / SmartHub port
- **Newer spas moved off Gizwits.** The classic "Bestway Smart Hub" app used the Gizwits cloud (email/password). The newer **Bestway / SmartSpa** app (AIRJET "V02") uses a **SmartHub AWS** backend with **anonymous visitor** auth and no password — you bind via a QR **Share-Device** code (`RW_Share_<request_id>_<device_id>`). Don't assume Gizwits.
- **No MITM needed.** The QR-bind path (`/api/enduser/grant_device`) lets an anonymous visitor bind your spa — no cert-unpinning/proxy. All the hard protocol work (visitor auth, the AES-256-CBC v2 command envelope with its fixed IV, the app id/secret, the shadow keys) is from [epheterson/bestway-spa-v2](https://github.com/epheterson/bestway-spa-v2).
- **Node port is 1:1.** AES key = `SHA-256("<sign>,<APPSECRET>")[:32]` as UTF-8 bytes (i.e. a 32-char hex slice used as 32 raw bytes → AES-256-CBC), output `base64(IV + ciphertext)`. Node `crypto` does this directly; no dependency needed.
- **Shadow keys:** `heater_state`, `wave_state` (bubbles/jets), `filter_state`, `power_state`, `temperature_setting` (°C), `water_temperature`, `temperature_unit` (1 = C).

## Smart-home assistant cloud-to-cloud (the hard part)
*Home Assistant users can skip this — you just hit the HTTP API. These are notes from the optional built-in cloud-to-cloud bridge, implemented against a major assistant's cloud; the same shape applies to others.*

1. **Use the canonical type/trait.** A hot tub is intuitively a `WATER_HEATER`, but Google **rejects `WATER_HEATER` + a temperature trait at link time** — account-linking fails with "couldn't reach service" right after you enter the code (token + SYNC return 200, then Google aborts before QUERY). The textbook **`THERMOSTAT` + `TemperatureSetting` (only)**, modes `["off","heat"]`, unit `"C"`, linked first try. Both `TemperatureSetting`-on-`WATER_HEATER` *and* `TemperatureControl`-on-`WATER_HEATER` failed; the type was the problem.
2. **One malformed device kills the entire SYNC** — including devices that already worked. If a re-sync makes everything disappear, suspect the newest device entry. Keep to documented shapes.
3. **Account-linking must answer within ~5 s** (SYNC *and* the initial QUERY). Our QUERY did a cold round-trip to the spa cloud (~5 s) and intermittently broke linking. Fix: serve QUERY from a **warm in-memory cache** refreshed in the background (`quickView()` + `startWarmup()` here).
4. **Adding a capability needs a full unlink + relink.** "Sync my devices" refreshes state and can add/remove devices, but won't teach Google a new trait on an existing device. If a new capability "isn't there," relink.
5. **Relinking orphans routines**, and **relinked devices come back unassigned** (won't show in the automation device-picker until you put them in a room). Delete+recreate the affected routines.
6. **Answer EXECUTE optimistically for a slow/remote cloud.** Reply within Google's window and let the command finish in the background, or Google says "something went wrong" even on success. (`GH_RESPOND_MS`.)
7. **A test/preview integration is enough** for personal use — no review, no privacy-policy/logo; just link it to your own account.

See the sibling project [evo-start-relay](https://github.com/cnghockey/evo-start-relay) for the same Google lessons applied to a car remote-starter (plus one more: you can't *unlock* a lock from an automation — model it as a switch).
