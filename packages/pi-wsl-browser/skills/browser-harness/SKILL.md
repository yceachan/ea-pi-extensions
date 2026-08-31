---
name: browser-harness
description: "Use the session-scoped pi-wsl-browser lease for interactive web work, automation, and site/app tasks."
---

# browser-harness through pi-wsl-browser

Use the package lifecycle tool before any interactive browser work. The tool is the only way to create or destroy the root target owned by this Pi session.

## Select a mode

- `headless` (default): an isolated temporary Edge profile for ordinary automation, JavaScript-rendered pages, and screenshots.
- `headed-tmp-profile`: an isolated visible profile when a human must see or interact with the window.
- `main-profile`: the inferred Edge profile with the user's existing login state. Use only when that state is necessary.

Temporary profiles are created under discovered Windows `%TEMP%`/`LocalAppData\\Temp` storage. Never configure or rely on WSL `/tmp` or `/home` paths for a Windows browser profile. A configured `tempProfileRoot` must be Windows-backed.

Edge is selected first when its executable is present. Chrome is used only when the Edge executable is absent; leftover Edge user data does not block fallback, and an Edge failure is not silently retried in Chrome.

## Required lifecycle

1. Call `wsl_browser` with `{"action":"acquire"}` or an explicit mode.
2. Start from the leased target. The first navigation is `goto_url(...)`:

   ```bash
   pi-wsl-browser run <<'PY'
   goto_url("https://example.com")
   wait_for_load()
   print(page_info())
   PY
   ```

3. Keep all page operations inside the target returned by the lease. Use the normal CDP helpers (`page_info`, `js`, AX/DOM inspection, screenshots, input, downloads, and raw non-target CDP methods) through the wrapper.
4. Before asking the user to log in, choose an account, approve consent, complete MFA, solve a CAPTCHA, or otherwise wait across agent runs, call `wsl_browser` with `{"action":"retain"}`.
5. Call `wsl_browser` with `{"action":"release"}` when the task is finished. Without `retain`, Pi automatically releases the lease at `agent_settled`; session shutdown releases everything, including retained leases.

The wrapper command resolves the current Pi session descriptor from `PI_SESSION_ID`/`PI_SESSION_FILE`. Do not pass a browser name, daemon name, lease id, CDP URL, or control token. Do not use target-list order to guess ownership.

## Target and tab rules

- Do not call `new_tab()` or raw `Target.createTarget` from an agent script.
- Do not attach to, navigate, or close a pre-existing user tab.
- Popups opened by a leased page remain usable when the managed runtime reports them as owned descendants.
- Use `switch_tab()` only with a target visible in the managed target list.
- If the wrapper reports no active lease, stop and acquire one through the lifecycle tool instead of attaching to another page.

## Interaction guidance

Prefer the accessibility tree for controls, then verify actions with a targeted `js(...)` or `page_info()` check. Use screenshots when layout or imagery matters. Wait for page load after navigation and use the standard CDP helpers for frames, dialogs, downloads, and network state.

For login walls, stop before passwords, MFA, consent, or an ambiguous account choice. Ask the user what to do, and retain the lease before waiting. Never print cookies, tokens, or credentials.

The package keeps the browser process and temporary profile session-scoped. Runtime selection is fixed to the bundled uv project and frozen lockfile; do not override Python, the runtime project, or `PYTHONPATH`. Do not start a second browser daemon, use an unrelated global harness executable, or enable a cloud/remote browser path from an agent script.
