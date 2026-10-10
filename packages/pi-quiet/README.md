# @yceachan/pi-quiet

Fork of [`@zenspc/pi-quiet` 0.4.1](https://github.com/zenspc/pi-extensions/tree/master/packages/pi-quiet), imported from the published npm package. The upstream MIT license and copyright are preserved in `LICENSE`; prior releases are recorded in `CHANGELOG.md`.

This fork targets Pi 1.1 or newer (typechecked against 1.1.0) and fixes the global renderer resolver: Pi passes `(toolName, next)`, not `(tool, renderers)`. It uses the actual name and calls `next()` to preserve stock and other extensions' renderers. This restores `read` / `bash` / `codemode` titles, `/quiet off`, and stock output on expansion.

Quiet Display for the [Pi coding agent](https://pi.dev): verb-first dense rows for tool activity, so new (and tired) users are not drowned in tool chrome and stdout.

Once installed, **Quiet Display is on by default**. Turn it off anytime with `/quiet off` (Sticky Preference).

## Install

```bash
pi install npm:@yceachan/pi-quiet
```

Local development from this monorepo:

```bash
pi -e ./packages/pi-quiet
pi install ./packages/pi-quiet
```

Do not load this fork and `@zenspc/pi-quiet` together: both register `/quiet` and a global tool renderer. Remove the upstream package before installing this fork. Before publication, use `pi install /absolute/path/to/mono/packages/pi-quiet`, then `/reload` in existing sessions. The existing `quiet.json` preference is reused.

## Development

```bash
bun install                  # from the monorepo root
bun run --cwd packages/pi-quiet test
bun run --cwd packages/pi-quiet typecheck
```

The regression suite uses an in-memory ExtensionAPI stub and TUI components; it needs no Pi process, terminal, model, or credentials.

## What you see

| Tool | Collapsed success | Notes |
|---|---|---|
| `read` | `📖 Read main.rs (40 lines)` | Requested range chips as `(start-end)`; images as `(image)` |
| `grep` / `find` | `🔍 Searched "pat" (3 matches)` | Zero hits = Soft Breakthrough `(no matches)` |
| `ls` | `📂 Listed src (12 entries)` | Empty dir = Soft `(empty)` |
| `edit` | `✏️ Edited main.rs (+3 -1)` | Diff body on expand |
| `write` | `📝 Wrote main.rs (12 lines)` | |
| `bash` | `💻 $ cmd` | Clean success omits chip; non-zero = Hard Breakthrough |
| Foreign Tools | `🧩 Called name peek` | Generic Kind Formatter when Pi exposes `registerToolRenderer` |

Running rows use present tense (`📖 Reading main.rs`). Settled rows use past tense.

### Verb Groups

Adjacent settled successes (and Soft Breakthroughs) of the **same Verb Group Kind** fold into one group:

```text
📖 Read 3 files
  • a.ts (40 lines)
  • b.ts (12 lines)
  • c.ts (8 lines)
```

Kinds:

| Kind | Tools | Folds? |
|---|---|---|
| File | `read` | yes |
| Search | `grep`, `find` | yes (together) |
| Dir | `ls` | yes |
| Command | `bash` | no (singleton) |
| EditFile | `edit`, `write` | no (singleton) |
| Other | Foreign Tools | yes (together, not by exact name) |

- **Strict neighbors only** - assistant/user prose or a different kind splits groups.
- **Hard Breakthrough** never joins a group and splits runs before/after.
- **Pending never joins** - a running tool stays a present-tense singleton Quiet Row. Already-settled same-kind neighbors **stay** grouped while a trailing same-kind tool is still running; the Verb Group grows only after that tool settles successfully (or soft).
- **Expand** expands the whole group to stacked Stock Display bodies.
- Groups are **rebuilt from session history** after reload.
- Path targets use **basename**; collisions inside a group disambiguate with a parent segment.

## Behavior notes

- **While running:** present-tense singleton, no live stdout firehose.
- **Tool Shell Background:** visible Quiet Rows and Verb Groups keep Stock's pending/success/error strip with **compact** (zero) padding. Hidden group members stay zero-height.
- **Hard Breakthrough:** failed edit/write, bash non-zero / thrown error, Foreign `failed` - chip + capped error tail without you expanding.
- **Expand** (pi's normal expand gesture): full Stock Display body for that row (or whole Verb Group), including the original Foreign Tool renderer. Expand does **not** change the Sticky Preference.
- **`/quiet`:** Sticky Preference only; renders follow the current preference when components redraw.

## Commands

| Command | Description |
|---|---|
| `/quiet` | Toggle Quiet Display |
| `/quiet on` | Quiet Display |
| `/quiet off` | Stock Display (pi's normal tool UI) |
| `/quiet status` | Show preference + config path |
| `/quiet help` | Help |

## Config

Package-local Sticky Preference:

```text
~/.pi/agent/extensions/quiet.json
```

(or `$PI_CODING_AGENT_DIR/extensions/quiet.json`)

```json
{
	"enabled": true
}
```

Missing or invalid file → Quiet Display **on**.

## Scope

**In (always):** built-in `read`, `bash`, `edit`, `write`, `find`, `grep`, `ls` (specialized Kind Formatters + Verb Groups).

**In (when Pi has `registerToolRenderer`):** Foreign Tools - extension tools, MCP gateways, SDK custom tools - via the Generic Kind Formatter (`🧩`, Called/Calling, arg peek) and Verb Group Kind Other.

**Out:** assistant prose, thinking, startup header, second density preference, durations on chips, Quiet-native expanded bodies (Stock-on-expand for now).

Without the upstream Tool Renderer Wrapper seam (`registerToolRenderer` on Pi's ExtensionAPI), Foreign Tools stay on Stock Display (built-ins still Quiet).

## Security notes

- Config is untrusted input: size-capped, regular-file only (no symlinks), atomic `0o600` writes.
- TUI chrome only. No network. Does not change tool execution semantics - only presentation.
- Foreign arg peeks skip secret-ish keys (`token`, `password`, `api_key`, …).
- Overriding built-ins (fallback path without the renderer hook) makes pi show its normal tool-override warning once; that is expected. With the hook, Quiet does not replace tools.

## License

MIT
