# ea-pi-extensions

A [bun](https://bun.sh) workspace monorepo for [yceachan](https://github.com/yceachan)'s pi
extensions. All packages share one lockstep version; releases publish only the packages that
actually changed.

## Packages

| Package | Description | Gallery |
| --- | --- | --- |
| [`@yceachan/pi-shelld`](packages/pi-shelld) | `shell_daemon` tool + ⭕shell TUI monitor for long-running background processes | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-oc-go-luna-vision`](packages/pi-oc-go-luna-vision) | visual understanding via gpt-5.6-luna when the main model has no vision | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-gadget`](packages/pi-gadget) | single-file utilities: `/clear` session archiving, `/exit` | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-switch-cwd`](packages/pi-switch-cwd) | `/cwd` — switch the session working directory | [pi.dev](https://pi.dev/packages) |

## Structure

```text
.
├── packages/           # workspace members (bun workspaces)
│   ├── pi-gadget/
│   ├── pi-oc-go-luna-vision/
│   ├── pi-shelld/
│   └── pi-switch-cwd/
├── scripts/
│   └── release.mjs     # lockstep version bump + Release commit + tag + push
└── .github/workflows/
    └── publish.yml     # tag-triggered CI publish (npm OIDC, provenance)
```

## Install

```bash
pi install npm:@yceachan/pi-shelld
pi install npm:@yceachan/pi-oc-go-luna-vision
pi install npm:@yceachan/pi-gadget
pi install npm:@yceachan/pi-switch-cwd
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
bun run release:patch   # or release:minor / release:major
```

`scripts/release.mjs` bumps **all** packages to one shared version, commits `Release vX.Y.Z`,
tags it, and pushes. The `publish.yml` workflow then diffs the tag range, detects which packages
changed, and publishes exactly those with `npm publish --provenance` (OIDC trusted publishing).

Prerequisite (one-time): configure npm [Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
for each package — repository `yceachan/ea-pi-extensions`, workflow `publish.yml`.

## License

MIT
