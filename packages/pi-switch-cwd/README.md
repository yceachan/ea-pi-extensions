# pi-switch-cwd

**English | [简体中文](./README.zh-CN.md)**

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

## Long sessions and prompt-prefix caching

`/cwd` preserves the conversation, but it does **not** preserve an identical provider prompt
prefix. This distinction matters in a long-running session that relies on prompt caching.

| Boundary | Behavior |
| --- | --- |
| While `/cwd` runs | No model request is made, so the command itself has no cache-read or token cost. |
| Session state | Session id, conversation entries, branches, and compaction state are preserved. Nothing is removed from the model's logical context. |
| First model request after the switch | Pi rebuilds cwd-bound runtime services. The system prompt always contains a different `Current working directory`; project context files, skills, settings, extensions, active tools, or tool schemas may differ too. The serialized prompt therefore diverges before the preserved conversation history. |
| Cache-miss scope | Provider-dependent. A provider may reuse the common prefix before the first changed token, but the conversation history after that divergence generally cannot be reused as the same cached prefix for this request. Expect a cold or mixed-cache turn, not context loss. |
| Later requests in the new cwd | The new prompt prefix can warm and receive normal cache hits again. Usually only the first model turn after a stable switch pays the transition cost. |
| Switching back | The old prefix may hit only if its provider cache entry is still alive, project resources and tool schemas are unchanged, and routing/session affinity reaches that cache. This is an optimization, not a guarantee. |
| Provider without prompt caching | There is no cache-hit penalty to observe; the rebuilt system prompt and project resources still change model behavior. |

Keeping the same session id, cache key, or session-affinity value does not bypass content-prefix
matching. Those values can route a request to a cache, but the prompt content must still satisfy
the provider's matching rules.

For long sessions:

- Prefer one-way phase transitions such as research directory → implementation repository; avoid
  repeatedly switching between projects when cache latency or input cost matters.
- If the retained conversation is very large and the switch is a durable phase boundary, consider
  `/compact` before `/cwd` so the first uncached request in the new cwd is smaller.
- Use absolute paths instead of `/cwd` for brief cross-directory operations when retaining the
  current prefix is more important than loading the target project's context, skills, settings,
  extensions, and cwd-bound tools.

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
