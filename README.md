# ea-pi-extensions

A [bun](https://bun.sh) workspace monorepo for [yceachan](https://github.com/yceachan)'s pi-extensions. Each package carries its own semver version; a release bumps only the packages it names and each package tag (`<pkg>@<ver>`) is its own publish instruction.

## Packages

| Package | Description | Gallery |
| --- | --- | --- |
| [`@yceachan/pi-shelld`](packages/pi-shelld) | `shell_daemon` tool + ⭕shell TUI monitor for long-running background processes | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-oc-go-luna-vision`](packages/pi-oc-go-luna-vision) | visual understanding via gpt-5.6-luna when the main model has no vision | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-gadget`](packages/pi-gadget) | single-file utilities: `/clear` session archiving, `/exit` | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-switch-cwd`](packages/pi-switch-cwd) | `/cwd` — switch the session working directory | [pi.dev](https://pi.dev/packages) |
| [`@yceachan/pi-better-mermaid`](packages/pi-better-mermaid) | `better-mermaid` — bundles the writing-mermaid rules as a skill, gates the agent-delivered diagram with mmdc validation, loops on structured errors (3 strikes) · [capability evals](packages/pi-better-mermaid/skills/better-mermaid/evals/README.md) | [pi.dev](https://pi.dev/packages) |

## Structure

```text
.
├── packages/           # workspace members (bun workspaces)
│   ├── pi-gadget/
│   ├── pi-oc-go-luna-vision/
│   ├── pi-shelld/
│   ├── pi-switch-cwd/
│   └── pi-better-mermaid/
├── gcm                      # bash entry → scripts/gcm.mjs (bun run gcm)
├── gbump                    # bash entry → scripts/gbump.mjs (manual release one-click)
├── scripts/
│   ├── gcm.mjs              # manual commit entry (type/scope validation, fuzzy scope pick)
│   ├── gbump.mjs            # pre-flight checks → delegates to mono-release
│   ├── mono-release.mjs     # per-package bump + release commit + package tag + push
│   └── mono-sync.mjs        # per-package registry-baseline check / alignment
├── docs/                     # 提交/发版规范 + tag 回退与 CI 容灾 runbook
│   ├── git提交规范.md
│   ├── 发行版本控制策略.md
│   └── tag回退与CI容灾.md
├── changelog/
│   └── <pkg>/vX.Y.Z/log.md  # per-package release notes (manual, docs(changelog):)
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
bun run gcm             # manual commit helper (see docs/git提交规范.md)
```

Manual commits follow the convention in [`docs/git提交规范.md`](docs/git提交规范.md); the `gcm` entry
composes and validates `type(scope): subject` and commits only what you staged:

```bash
git add packages/pi-shelld/src/…
bun run gcm -- -t fix -p shelld -m "drain zombie shells on session end"
```

No build step — pi loads TypeScript directly via jiti. Edit sources and `/reload` in pi.

## Release

Per-package versioning, tag-as-publish-instruction:

```bash
./gbump -p pi-gadget --minor                   # one-click: pre-flight checks then release
./gbump -p pi-gadget --set-ver 0.5.0           # explicit target version
./gcm -c -p pi-gadget --minor                  # scaffold the changelog, prints path + commit hint
bun run mono-release -- pi-gadget minor pi-shelld patch  # ceremony directly (skips gbump pre-flight)
```

`./gbump` is the one-click manual release entry: it enforces a clean working tree, that the
package's local version equals its registry baseline, and that
`changelog/<pkg>/vX.Y.Z/log.md` exists with real entries — then delegates to
`scripts/mono-release.mjs`, which bumps only the named packages, commits
`release: pi-gadget@0.3.0`, tags each `pi-gadget@0.3.0`, and pushes — after enforcing a
clean working tree, that the target version is not yet on the registry for that package,
and that the package actually changed since its last package tag. Write release notes
first: `./gcm -c -p <pkg> --minor` scaffolds
`changelog/<pkg>/vX.Y.Z/log.md`, which you fill in and commit as
`docs(changelog): <pkg> vX.Y.Z`.
The `publish.yml` workflow (trigger: tags matching `*@*`) parses the tag, verifies
`packages/<pkg>/package.json` matches the tag version, and publishes exactly that
package with `npm publish --provenance` (OIDC trusted publishing). A `workflow_dispatch`
dry-run entry runs the same validation without publishing — use it to test pipeline changes.

`bun run mono-sync` shows each package's local version against its registry baseline;
`bun run mono-sync -- --sync` aligns any package that lags behind, automatically
refreshes the workspace with `bun install` (so `bun.lock` follows), and reports the
changed files and dirty-tree state — review and commit before releasing.

Prerequisite (one-time): configure npm [Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
for each package — repository `yceachan/ea-pi-extensions`, workflow `publish.yml`.

## License

MIT
