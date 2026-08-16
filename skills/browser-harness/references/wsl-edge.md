# Browser control: headless-first; this file covers the headed fallback

Machine: pi agent inside WSL2, driving Microsoft Edge on Windows via CDP.

> **Headless-first policy**: prefer `scripts/bh-headless` (one-shot `shot`
> mode or auto-destroyed interactive sessions) for screenshots, vision, and
> public-page automation. The headed modes below are ONLY for login state or
> bot-protected pages — and after every headed task run `bh-edge-close all`
> (MANDATORY: kills the dedicated instance + wipes session-restore state;
> login cookies survive). See SKILL.md "This Machine".

## Two modes

| | **auto (default)** | **daily (fallback)** |
| --- | --- | --- |
| Instance | Dedicated Edge, port **9333**, own profile `C:\Users\yceachan\AppData\Local\bh-edge\profile` | User's daily Edge, port **9222** (edge://inspect toggle, DevToolsActivePort) |
| Popups | **None** — M144+ "Allow remote debugging" dialog only applies to the DEFAULT profile; explicit `--remote-debugging-port` + non-default profile needs no confirmation (verified) | One Allow click per Edge session, per new WS connection |
| HTTP API | `/json/version` works → use `BU_CDP_URL` | 404s (Edge quirk) → must use raw `BU_CDP_WS` |
| Login state | Fresh profile — user logs in once per site; persists across restarts | Full login state |
| Use when | Default. Scraping, form filling, testing, most tasks | Task needs the user's logged-in session (e.g. private platforms) |

## Preferred flow (zero popups)

1. Ensure dedicated Edge is running (auto-launch if :9333 doesn't answer):

   ```bash
   "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
     --remote-debugging-port=9333 \
     --user-data-dir='C:\Users\yceachan\AppData\Local\bh-edge\profile' \
     --no-first-run --no-default-browser-check
   ```

2. `export BU_CDP_URL=http://localhost:9333` then use browser-harness normally.
   The daemon resolves the ws URL from `/json/version` itself.
3. Wrapper: `echo 'print(page_info())' | ~/.agents/skills/browser-harness/scripts/bh-edge` (auto-launches + connects).
4. Helper: `wsl_edge_auto()` returns `("auto", "http://localhost:9333")`;
   `wsl_edge_connect()` prefers auto, falls back to daily.

## Daily-Edge flow (login state, one popup per session)

Read `DevToolsActivePort` from the Windows profile; use `BU_CDP_WS` (never
`BU_CDP_URL` — its HTTP API 404s in toggle mode). When a fresh connection is
needed, the Windows side pops "Allow remote debugging" — ask the user to click
Allow; the handshake is held until then (do not retry in a loop; the daemon's
single held connection makes it a one-time click per Edge session).

```
/mnt/c/Users/yceachan/AppData/Local/Microsoft/Edge/User Data/DevToolsActivePort
# line 1: port (9222)   line 2: ws path (/devtools/browser/<uuid>) — uuid changes per Edge restart
```

Edge restart → new uuid → restart daemon: `restart_daemon()` with new `BU_CDP_WS`.

## Cookie transfer (optional, if login state is needed in the dedicated Edge)

Via CDP, no disk access: `Network.getAllCookies` on the daily Edge →
`Network.setCookies` on the dedicated instance. Cookies only; localStorage /
IndexedDB auth won't transfer. Ask the user before touching cookies (real auth).

## Gotchas

- Don't kill msedge processes wholesale — the user's daily Edge runs many
  processes; only touch the dedicated one (command line matches `bh-edge\profile`).
- Both instances coexist: user's Edge on 9222, automation Edge on 9333.
- Recordings: enabled (config) — screenshots/action traces of harness actions.
