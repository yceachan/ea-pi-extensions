# @yceachan/pi-wsl-browser

A Pi extension for session-scoped browser leases from WSL to Microsoft Edge (with Chrome fallback). It owns the browser targets it creates while leaving the user's existing tabs and main browser process alone.

## Install

```bash
pi install npm:@yceachan/pi-wsl-browser
pi install npm:@yceachan/pi-shelld
```

`pi-wsl-browser` declares `pi-shelld` as a runtime dependency, so npm installation brings in a compatible version. Pi still loads extension resources explicitly; the second command enables `pi-shelld` as a Pi package. For an isolated workspace checkout, use `pi --no-extensions -e packages/pi-shelld -e packages/pi-wsl-browser`. `pi-shelld` supplies the session-scoped service used for the private controller/daemon and its TUI log monitor.

## Workflow

1. Call the `wsl_browser` tool with `{"action":"acquire"}` (the default is `headless`).
2. Run browser-harness Python through the package wrapper:

   ```bash
   pi-wsl-browser run <<'PY'
   goto_url("https://example.com")
   print(page_info())
   PY
   ```

3. Call `{"action":"retain"}` before waiting for a user, login, MFA, or CAPTCHA. Otherwise Pi's `agent_settled` event releases the lease automatically.
4. Call `{"action":"release"}` when finished. Session shutdown always releases remaining targets and removes temporary profiles.

Modes are `headless`, `headed-tmp-profile`, and `main-profile`. Temporary modes use a unique profile under discovered Windows `%TEMP%`/`LocalAppData\Temp` storage and a dynamic DevTools port; they never use WSL `/tmp` or `/home` UNC paths. A configured `tempProfileRoot` must be a Windows-backed drive path. `main-profile` infers `profile.last_used` from Edge's `Local State` and never kills the user's browser process.

The wrapper resolves the descriptor for the current `PI_SESSION_ID`/`PI_SESSION_FILE`; it does not accept a daemon, lease, browser name, or CDP endpoint from the agent. Each session gets private `BH_RUNTIME_DIR` and `BH_TMP_DIR` directories under its package state; those paths are shared by the controller and wrapper and removed at shutdown.

## Configuration

Defaults are bundled in `config.json`. The optional user override is:

```text
$PI_CODING_AGENT_DIR/pi-wsl-browser/config.json
```

Example:

```json
{
  "browser": "auto",
  "executable": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "userDataDir": "C:\\Users\\<user>\\AppData\\Local\\Microsoft\\Edge\\User Data",
  "profileDirectory": "Default",
  "tempProfileRoot": "C:\\Users\\<user>\\AppData\\Local\\Temp\\pi-wsl-browser"
}
```

`auto` selects Edge first and falls back to Chrome only when the Edge executable is absent. An Edge startup, CDP, or authorization failure is returned as an Edge error; it is never silently retried with Chrome. Paths are discovered through Windows/WSL and the package does not embed a username. Runtime selection is fixed to the bundled uv project and frozen lockfile.

## Migration and development

`pi-wsl-browser doctor` reports legacy Skill, launcher, and global `uv` installations. It never removes user files or credentials; review and migrate those paths manually.

The Python runtime is a pinned, package-private fork under `runtime/browser-harness/` with its own `uv.lock`. The controller and wrapper run it with the bundled `uv run --project ... --frozen` command; the first run may create uv's cache environment, but it never changes the lock or downloads a newer upstream release. Caller-selected Python, runtime roots/projects, and `PYTHONPATH` are ignored. `uv` is required in production (a runner probe is injectable only in TypeScript tests). See [UPSTREAM.md](UPSTREAM.md) for the baseline and merge checklist.

```bash
bun run typecheck
bun run test
npm pack --dry-run
```

GUI, user-profile, and authorization E2E checks are intentionally manual and are not part of the default test suite.
