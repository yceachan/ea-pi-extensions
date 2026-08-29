# pi-shelld

A [pi](https://github.com/earendil-works/pi) extension that lets the agent launch and manage
long-running background processes — `npm run dev`, servers, watchers — through a dedicated
`shell_daemon` tool, and gives the human a keyboard-driven **⭕shell** monitor to watch and stop
them from the session.

- **shell_daemon tool** — the LLM starts/stops/lists background shells and reads their output.
- **⭕shell monitor** — a footer status entry (visible while shells exist) opening a TUI overlay:
  a ps list page and a per-shell details page (status, runtime, command, live output) with
  clickable URLs, plus `x` to stop.

Every shell follows the session lifecycle: closing the session stops all its shells. State lives
per session at `~/.pi/agent/sessions/--<cwd>--/<session>.shelld/`.

## Install

```bash
pi install npm:@yceachan/pi-shelld        # published package
pi install git:github.com/yceachan/ea-pi-extensions@main  # or from the monorepo
pi -e npm:@yceachan/pi-shelld             # try once without installing
```

## Usage

- Tell the agent to start a dev server: it will call `shell_daemon` with `action: "start"`.
- Open the monitor with the ⭕shell footer entry: press the registered shortcut (see
  `docs/keybindings.md` in pi) or run `/shelld`.

## Extension integration

Separately loaded pi extensions can discover the versioned `pi-shelld:service:v1` service
through `pi.events`. Its minimal `start`/`close` API lets integrations share the same shell
registry, lifecycle lock, logs, and ⭕shell monitor without importing, depending on, or
bundling pi-shelld. `start` also returns an in-memory `settled` promise for the spawned
process; persistent shell status remains the two-state pid-derived model.

## Persistence and lifecycle

A shell started with `action: "start"` is detached from the extension and keeps running after the tool call returns. This lets a server, watcher, or other long-running process continue while the agent works; later `ps`, `status`, and `logs` calls inspect the same shell. The registry and merged stdout/stderr log are stored under the current pi session's `*.shelld/` directory.

This persistence is session-scoped, not permanent. `session_shutdown` stops every tracked process tree and removes that session's state and logs. If pi exits abnormally, a later start of the same session reaps any orphaned trees before use. Use `stop` to end a shell while preserving its record and log for inspection, then `close` to delete both.

## Development

No build step — pi loads TypeScript directly via jiti. Edit `src/`, reload the extension
(`/reload` in pi) to pick up changes.

For local typechecking, install the dev dependencies with `bun install` — these are
`devDependencies` only and are omitted at runtime.

## License

MIT
