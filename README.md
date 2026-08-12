# ea-pi-extensions

A [bun](https://bun.sh) workspace monorepo for [yceachan](https://github.com/yceachan)'s pi-extensions. All packages share one lockstep version; releases publish only the packages that
actually changed.

## Packages

| Package | Description | Gallery |
| --- | --- | --- |
| [`@yceachan/pi-shelld`](packages/pi-shelld) | `shell_daemon` tool + ⭕shell TUI monitor for long-running background processes | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-oc-go-luna-vision`](packages/pi-oc-go-luna-vision) | visual understanding via gpt-5.6-luna when the main model has no vision | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-gadget`](packages/pi-gadget) | single-file utilities: `/clear` session archiving, `/exit` | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-switch-cwd`](packages/pi-switch-cwd) | `/cwd` — switch the session working directory | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-better-mermaid`](packages/pi-better-mermaid) | `better-mermaid` — bundles the writing-mermaid rules as a skill, gates the agent-delivered diagram with mmdc validation, loops on structured errors (3 strikes) | [pi.dev](https://pi.dev/packages) |

## Structure

```text
.
├── packages/           # workspace members (bun workspaces)
│   ├── pi-gadget/
│   ├── pi-oc-go-luna-vision/
│   ├── pi-shelld/
│   ├── pi-switch-cwd/
│   └── pi-better-mermaid/
├── scripts/
│   ├── mono-release.mjs     # lockstep bump + release commit + tag + push
│   └── mono-sync.mjs        # version check / registry alignment
├── changelog/
│   └── vX.Y.Z/log.md        # per-release notes (manual, docs(changelog):)
└── .github/workflows/
    └── publish.yml     # tag-triggered CI publish (npm OIDC, provenance)
```

## Install

```bash
pi install npm:@yceachan/pi-shelld
pi install npm:@yceachan/pi-oc-go-luna-vision
pi install npm:@yceachan/pi-gadget
pi install npm:@yceachan/pi-switch-cwd
pi install npm:@yceachan/pi-better-mermaid
```

## Development

```bash
bun install             # install the workspace (single root bun.lock)
bun run typecheck       # typecheck all packages
```

No build step — pi loads TypeScript directly via jiti. Edit sources and `/reload` in pi.

## Release

Lockstep versioning with on-demand publishing:

```bash
bun run mono-release:patch   # or mono-release:minor / mono-release:major
```

`scripts/mono-release.mjs` bumps **all** packages to one shared version, commits `release: vX.Y.Z`,
tags it, and pushes — after enforcing a clean working tree and the presence of real package
changes. Write release notes first (`changelog/vX.Y.Z/log.md`, committed as `docs(changelog):`).
The `publish.yml` workflow then diffs the tag range (excluding the release commit itself),
detects which packages changed, and publishes exactly those with `npm publish --provenance`
(OIDC trusted publishing).

Prerequisite (one-time): configure npm [Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
for each package — repository `yceachan/ea-pi-extensions`, workflow `publish.yml`.

## License

MIT
