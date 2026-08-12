# pi-switch-cwd

pi extension: **`/cwd`** — switch the session working directory (the session file moves with it).

## Why

When you discuss/research in a **large working directory** and then move into an **engineering
directory** to implement — without switching sessions: every bash round would otherwise need
`cd $CWD`, which costs context tokens.

After `/cwd`, the bash/read/write tools, AGENTS.md context, and skills all point at the new
directory automatically — "pwd" just works in the project directory.

## Usage

```text
/cwd                show the current cwd
/cwd <path>         switch to <path> (relative to the current cwd; ~ expands to $HOME;
                    missing directories are created with mkdir -p)
```

- Tab completion: directories only; dot-directories are hidden by default (shown when the input
  starts with `.`)
- Target == current cwd → no-op; path is a file → error
- Waits for the agent to be idle before switching (stops mid-stream first)

## How it works

pi has no "change cwd in place" API — tools, context, and skills are cwd-bound services that are
only rebuilt when the session runtime is replaced. So `/cwd` **relocates the session**:

1. Serialize the session from memory (header `cwd` field rewritten; id/entries preserved)
2. Write it to the target cwd's session directory (`~/.pi/agent/sessions/--<encoded path>--/`)
3. `switchSession` swaps the runtime (services for the new cwd rebuild automatically)
4. Delete the old session file on success

**Same session identity** (id unchanged, full history); switching back and forth accumulates
nothing; if another extension vetoes the switch, the old file is kept untouched. Side effect:
the session appears in `/resume` only under the directory it currently lives in.

## Install

```bash
pi install npm:@yceachan/pi-switch-cwd
```

## Development

```bash
bun install                 # dev dependencies
bunx tsc                    # typecheck
bun cwd-utils.test.ts       # pure-function unit tests
./e2e-test.sh               # real e2e (tmux + real pi, needs a configured default model)
```

## License

MIT
