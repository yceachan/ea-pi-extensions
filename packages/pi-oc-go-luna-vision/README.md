# pi-oc-go-luna-vision

Visual understanding for pi: when the main model has no vision capability, this package routes
image recognition / description / analysis to the **gpt-5.6-luna** model via the opencode-go
provider (OpenAI Responses API).

Ships as a full pi package bundling three parts:

```text
pi-oc-go-luna-vision/
├── package.json                    # pi manifest: extensions + skills
├── extensions/
│   └── oc-go-luna-vision.ts        # registers the `oc-go-luna-vision` custom tool
└── skills/
    └── oc-go-luna-vision/
        ├── SKILL.md                # trigger conditions, parameter semantics, troubleshooting
        └── scripts/
            └── vision.py           # implementation: OpenAI Responses API → gpt-5.6-luna
```

## Install

```bash
pi install npm:@yceachan/pi-oc-go-luna-vision
```

Or as a local path in `~/.pi/agent/settings.json`:

```json
"~/work/pi-agent-harness/extensions/mono/packages/pi-oc-go-luna-vision"
```

After changes, run `/reload` in pi (or restart pi) to hot-reload.

## Usage

Prefer the `oc-go-luna-vision` tool (schema requires `images` and `prompt`):

```text
oc-go-luna-vision images=[path1, path2] prompt="Describe this image in detail" effort=high max_tokens=4096
```

- `images`: image paths; Windows (`C:\...`) and WSL (`/mnt/...`) paths supported; multiple images
- `prompt`: **required**; must be explicitly constructed from the user's intent
  (describe / transcribe / compare, etc.), never omitted
- `effort`: thinking depth (default `high`; `medium` is prone to speculative hallucinations;
  `xhigh`/`max` need `max_tokens` raised to 8000+)
- `max_tokens`: output budget including reasoning tokens (default 4096, range 256–32768)

The tool and the skill share the same `scripts/vision.py`, so behavior is identical.

## Dependencies

- Runtime: `python3` only (standard library); reads `~/.pi/agent/models-store.json` and
  `~/.pi/agent/auth.json` for configuration
- npm side: peerDependencies declare the pi core packages (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`), provided by pi itself, never bundled

## License

MIT
