# ea-pi-extensions

**English | [简体中文](README.zh-CN.md)**

A [bun](https://bun.sh) workspace monorepo for [yceachan](https://github.com/yceachan)'s pi extensions. Each package has its own version and is released with its own `<pkg>@<ver>` tag.

## Packages

| Package | Description | Gallery |
| --- | --- | --- |
| [`@yceachan/pi-better-btw`](packages/pi-better-btw) | `/btw`, a fork of [nicobailon/pi-side-chat](https://github.com/nicobailon/pi-side-chat); opens an overlay for main-thread side questions, shares the prompt prefix, and uses a side-lane guard to keep the agent from interfering with main work | [pi.dev](https://pi.dev/packages/@yceachan/pi-better-btw) |
| [`@yceachan/pi-better-mermaid`](packages/pi-better-mermaid) | `better-mermaid` — packages Mermaid guidance as a skill, checks Typora rendering constraints with `mmdc`, and retries syntax errors | [pi.dev](https://pi.dev/packages/@yceachan/pi-better-mermaid) |
| [`@yceachan/pi-codex-imagegen`](packages/pi-codex-imagegen) | Uses the local Codex login to generate images with `imagegen`; a separately loaded `pi-shelld` shows live logs, status, and runtime | [pi.dev](https://pi.dev/packages/@yceachan/pi-codex-imagegen) |
| [`@yceachan/pi-gadget`](packages/pi-gadget) | Single-file utilities: `/clear` archives the session, `/exit` quits pi, and `pi-cite-wslpath` converts WSL paths into clickable Windows Terminal links | [pi.dev](https://pi.dev/packages/@yceachan/pi-gadget) |
| [`@yceachan/pi-shelld`](packages/pi-shelld) | `shell_daemon` tool + ⭕shell TUI monitor for session-scoped background shells (servers, watchers); other extensions can discover and reuse its service through `pi.events` | [pi.dev](https://pi.dev/packages/@yceachan/pi-shelld) |
| [`@yceachan/pi-switch-cwd`](packages/pi-switch-cwd) | `/cwd` — switch the session working directory | [pi.dev](https://pi.dev/packages/@yceachan/pi-switch-cwd) |
| [`@yceachan/pi-vision-helper`](packages/pi-vision-helper) | Vision helper for models without image input; uses pi-registry or a custom Responses API | [pi.dev](https://pi.dev/packages/@yceachan/pi-vision-helper) |
| [`@yceachan/pi-wsl-browser`](packages/pi-wsl-browser) | Session-scoped WSL Windows Edge/Chrome browser leases for pi | [pi.dev](https://pi.dev/packages/@yceachan/pi-wsl-browser) |

## Layout

```text
.
├── packages/           # workspace members (bun workspaces)
│   ├── pi-better-btw/
│   ├── pi-better-mermaid/
│   ├── pi-codex-imagegen/
│   ├── pi-gadget/
│   ├── pi-shelld/
│   ├── pi-switch-cwd/
│   └── pi-vision-helper/
├── gcm                      # bash entry → scripts/gcm.mjs (bun run gcm)
├── gbump                    # bash entry → scripts/gbump.mjs (manual release one-click)
├── sync-readme              # bash entry → scripts/sync-readme.mjs (README package table + install block)
├── scripts/
│   ├── lib.mjs              # shared: registry queries, fuzzy scope resolution, ask()
│   ├── gcm.mjs              # manual commit entry (type/scope validation, fuzzy scope pick)
│   ├── gbump.mjs            # thin wrapper: arg translation → delegates to mono-release
│   ├── sync-readme.mjs      # rebuild README ## Packages table (gallery → per-package pi.dev page)
│   ├── mono-release.mjs     # per-package bump + release commit + package tag + push
│   ├── mono-tagcheck.mjs    # per-package version-number check/align/reset (no git writes)
│   └── completions/
│       └── _gbump           # zsh completion (#compdef gbump gcm): -p candidates, flags, type words
├── docs/                     # 提交/发版规范 + tag 回退与 CI 容灾 runbook
│   ├── git提交规范.md
│   ├── 发行版本控制策略.md
├── changelog/
│   └── <pkg>/vX.Y.Z/log.md  # per-package release notes (manual, docs(changelog):)
└── .github/workflows/
    └── publish.yml     # tag-triggered CI publish (npm OIDC, provenance)
```

## Install

```bash
pi install npm:@yceachan/pi-better-btw
pi install npm:@yceachan/pi-better-mermaid
pi install npm:@yceachan/pi-codex-imagegen
pi install npm:@yceachan/pi-gadget
pi install npm:@yceachan/pi-shelld
pi install npm:@yceachan/pi-switch-cwd
pi install npm:@yceachan/pi-vision-helper
pi install npm:@yceachan/pi-wsl-browser
```

## Development

```bash
bun install             # install the workspace
bun run typecheck       # typecheck all packages
./gcm --help            # view the commit helper
ls docs/*               # view repository docs
```

## License

MIT copyright @2026 yceachan
