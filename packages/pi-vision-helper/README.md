# pi-vision-helper

Visual understanding for pi: when the main model has no vision capability, this package routes
image recognition / description / analysis to a **configurable vision model** via the OpenAI
Responses API. Pure TypeScript — single runtime, no python.

- **Default (no config)**: searches the **pi-registry** — the first vision-capable `luna` model
  in `~/.pi/agent/models-store.json` (currently `gpt-5.6-luna` via `opencode-go`), API key from
  `~/.pi/agent/auth.json`.
- **Config-driven**: `vision.models[]` mixes `pi-registry` entries (fuzzy provider/model match,
  pi auth) and `responses` entries (custom baseUrl + `$ENV_VAR`/literal apiKey); `vision.active`
  picks the model, `enabled`/`forceVisionBridge`/`maxTokens`/`timeoutMs`/`systemPrompt` tune
  behavior.

> 中文文档：[README.zh.md](./README.zh.md)

Ships as a full pi package bundling:

```text
pi-vision-helper/
├── package.json                    # pi manifest: extensions + skills
├── lib/                            # core (shared by tool + CLI): config, registry, vision
│   ├── config.ts                   # config resolution + schema normalization
│   ├── registry.ts                 # models-store / auth.json access + fuzzy matching
│   └── vision.ts                   # target resolution + Responses API round trip
├── extensions/
│   └── pi-vision-helper.ts         # registers the `pi-vision-helper` custom tool (in-process)
├── skills/
│   └── pi-vision-helper/
│       ├── SKILL.md                # trigger conditions, config schema, troubleshooting
│       └── scripts/
│           └── vision.ts           # CLI for manual debugging (bun), same lib/
├── README.md                       # this file (en)
└── README.zh.md                    # 中文文档
```

## Install

```bash
pi install npm:@yceachan/pi-vision-helper
```

Or as a local path in `~/.pi/agent/settings.json`:

```json
"~/work/pi-agent-harness/extensions/mono/packages/pi-vision-helper"
```

After changes, run `/reload` in pi (or restart pi) to hot-reload.

## Usage

Prefer the `pi-vision-helper` tool (schema requires `images` and `prompt`):

```text
pi-vision-helper images=[path1, path2] prompt="Describe this image in detail" effort=high max_tokens=4096
```

- `images`: image paths; Windows (`C:\...`) and WSL (`/mnt/...`) paths supported; multiple images
- `prompt`: **required**; must be explicitly constructed from the user's intent
  (describe / transcribe / compare, etc.), never omitted
- `effort`: thinking depth (default `high`; `medium` is prone to speculative hallucinations;
  `xhigh`/`max` need `max_tokens` raised to 8000+; `off`/`minimal` omit the reasoning field —
  the zen gateway rejects them verbatim with HTTP 400)
- `max_tokens`: output budget including reasoning tokens (default from config `maxTokens`,
  else 4096, range 256–32768)

Manual CLI (same core, for debugging):

```bash
bun packages/pi-vision-helper/skills/pi-vision-helper/scripts/vision.ts img.png \
  --prompt "describe" --model luna-customer --effort high --max-tokens 4096
```

## Configuration

Config files, first found wins:

| Priority | Path | Scope |
| --- | --- | --- |
| 1 | `--config <path>` (CLI flag) | explicit, missing file = hard error |
| 2 | `$PI_VISION_HELPER_CONFIG` | explicit env override, missing file = hard error |
| 3 | `$CWD/.pi/vision-helper.json` | project-level (committable, shared per repo) |
| 4 | `~/.pi/agent/pi-vision-helper.json` | user-level (global default) |

No config file at all = default behavior: search the pi-registry and use the first matching
`luna` model (with `image` in its `input` list) found in the first provider that has one.

### Full config example

```jsonc
{
  // ── Global switches ────────────────────────────────────────────────────
  "enabled": true,                  // master switch; false = the tool/CLI refuses to run
  "forceVisionBridge": false,       // true = delegation allowed even when the main model
                                    //   is itself a VLM (default: only for blind models)
  "maxTokens": 4096,                // default max output tokens incl. reasoning;
                                    //   the tool/CLI parameter overrides it
  "timeoutMs": 60000,               // default timeout per vision call (ms);
                                    //   the pi tool falls back to 300000 when unset
  "systemPrompt": "",               // custom system prompt for the vision model;
                                    //   empty = built-in default (verbatim transcription etc.)

  // ── Models & APIs ──────────────────────────────────────────────────────
  "vision": {
    "active": "luna",               // active model name; absent = first entry in models[];
                                    //   models[] empty = legacy flat fields / default luna search
    "models": [
      {
        // ① pi-registry entry — reuse pi's model catalog & pi auth
        "name": "luna",             // unique name (used by vision.active / CLI --model)
        "type": "pi-registry",      // "pi-registry" | "responses"
        "Provider": "opencode-go",  // fuzzy-match a provider in models-store.json
                                    //   (case-insensitive; no match = error listing providers)
        "Model": "gpt-5.6-luna",    // fuzzy-match a model under that provider; prefers
                                    //   entries with "image" in input; absent = first
                                    //   vision-capable (luna-first) model
        // optional overrides (pi-registry):
        // "cost": { "input": 0.1, "output": 0.6,
        //           "cacheRead": 0.01, "cacheWrite": 0.125 },  // USD per M tokens;
        //                                                      //   default = store entry cost
        // "headers": { "X-Foo": "bar" }                        // extra request headers
      },
      {
        // ② responses entry — any OpenAI-Responses-compatible endpoint
        "name": "luna-customer",
        "type": "responses",
        "baseUrl": "https://opencode.ai/zen/go/v1",
                                    // REQUIRED: endpoint root ("/responses" is appended)
        "apiKey": "$VISION_API_KEY",// REQUIRED: "$ENV_VAR" reference or a literal key
        "model": "gpt-5.6-luna",    // REQUIRED: literal model id (no registry lookup)
        // optional (responses):
        // "cost": { "input": 0.1, "output": 0.6 },            // default = 0 (uncounted)
        // "headers": { "X-Foo": "bar" }                       // extra request headers
      }
    ]
  }
}
```

### Field reference

#### Top level

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | Master switch. `false` = the tool returns a "disabled" text and the CLI exits with an error. |
| `forceVisionBridge` | bool | `false` | Lift the trigger restriction: allow delegation even when the main model is itself a VLM. |
| `maxTokens` | number | 4096 | Default `max_output_tokens` (incl. reasoning) when the tool/CLI passes none. |
| `timeoutMs` | number | 60000 | Default per-call HTTP timeout in milliseconds (the pi tool uses 300000 when unset). |
| `systemPrompt` | string | `""` | Replaces the built-in vision-assistant instructions; `""` keeps the default. |
| `vision` | object | — | Model selection block (below). Absent = legacy flat fields / default luna search. |

#### vision

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `active` | string | first entry | Name of the active model entry. Unknown name falls back to the first entry. |
| `models` | array | `[]` | Model entries in priority order. Empty = legacy flat fields / default luna search. |

#### Model entry

Fields depend on `type`:

| Field | `pi-registry` | `responses` | Meaning |
| --- | --- | --- | --- |
| `name` | ✓ | ✓ | Unique entry name (`active` / CLI `--model`). Defaults to `<Provider>/<Model>` or `<model>`. |
| `type` | ✓ | ✓ | `"pi-registry"` = reuse pi's catalog + auth; `"responses"` = custom endpoint. |
| `Provider` | ✓ | — | Fuzzy provider match in `models-store.json` (case-insensitive; `provider` also accepted). No match = error listing available providers. |
| `Model` | ✓ | — | Fuzzy model match under that provider, preferring vision-capable entries (`model` also accepted). Absent = first vision-capable (luna-first) model. |
| `baseUrl` | — | ✓ | Endpoint root; `/responses` is appended. |
| `apiKey` | — | ✓ | `$ENV_VAR` reference (expanded at call time; unset env = error) or a literal key. |
| `model` | — | ✓ | Literal model id — no registry lookup. |
| `cost` | ✓ | ✓ | USD per M tokens `{input, output, cacheRead, cacheWrite}`; overrides the store entry cost / defaults to 0. |
| `headers` | ✓ | ✓ | Extra HTTP headers merged into the request. |

#### Fuzzy matching

Deterministic order: exact (case-insensitive) > candidate contains needle >
needle contains candidate > **no match = error** (never silently picks the first candidate —
that would route unknown providers to the wrong backend and bill it).

### Legacy flat fields (still supported)

Without a `vision` block, the old single-model fields keep working:

```jsonc
{
  "provider": "opencode-go",        // registry provider (default: first provider)
  "model": "gpt-5.6-luna",          // registry model id (fuzzy; default: luna search)
  "modelMatch": "exact",            // "exact" | "substring"
  "baseUrl": "https://...",         // override / custom endpoint
  "apiKey": "$VISION_API_KEY",      // key override ($ENV_VAR or literal)
  "apiKeyEnv": "VISION_API_KEY",    // alternative: env var name holding the key
  "cost": { "input": 0.1, "output": 0.6 },
  "headers": { "X-Foo": "bar" },
  "defaults": { "effort": "high", "maxTokens": 4096 }
}
```

### Resolution precedence

Tool/CLI parameters > config file > pi-registry (models-store.json + auth.json) > built-in
defaults (luna / `high` / 4096). For keys specifically: entry `apiKey` > entry env var >
`auth.json[provider].key`.

## How it works

- **Request**: OpenAI Responses API — `POST {baseUrl}/responses` with `input_text` (your
  prompt) and one `input_image` per image (`data:<mime>;base64,...`). The base64 bytes exist
  only in memory and in that HTTPS request — they never enter the main model's context or the
  session history. A model entry's `api` field in models-store.json is advisory only: the zen
  gateway serves `/responses` for models declared as openai-completions too (verified with
  kimi-k2.7-code).
- **Effort**: `off`/`minimal` omit the `reasoning` field entirely (the zen gateway maps them to
  null; sending them verbatim produces HTTP 400 `invalid_prompt`).
- **Usage & cost**: the tool reports tokens and USD cost through pi's Usage accounting —
  registry entry cost by default, per-entry `cost` override, 0 when unknown.
- **Errors**: config/registry problems fail loudly with actionable messages (available
  providers/models listed, env-var names, which config file was read) — no silent fallbacks.
