# pi-gadget

A small collection of single-file [pi](https://github.com/earendil-works/pi) extensions — handy
gadgets, each living in one file:

- **`/clear`** — archive the current session (moves it out of the way while keeping it resumable)
- **`/exit`** — exit pi cleanly
- **`pi-cite-wslpath`** — tool for the model: converts native (WSL) paths into Windows-Terminal-openable markdown hyperlinks, because `file:///home/...` / `file:///mnt/c/...` links are rejected by Windows Terminal. Takes a `paths[]` batch in one call; an `agent_end` hook force-checks every delivered reply for un-converted links and posts a clickable report (detect-and-tell)

## Install

```bash
pi install npm:@yceachan/pi-gadget
```

## Usage

Run `/clear` to archive the active session, `/exit` to quit pi. Both commands are plain
slash-command extensions; see the source files for exact behavior.

`pi-cite-wslpath` is a tool the model calls to cite file paths clickable in Windows
Terminal (Ctrl+click). Conversion rules: `/mnt/<drive>/...` → `file:///<DRIVE>:/...`,
other Linux paths → `file://wsl.localhost/<distro>/...` (Windows Terminal ≥ 1.17).
Outside WSL it falls back to the standard `file://` URI.

The tool takes a `paths` array (one or more native paths) and returns exactly one markdown
link per path (`[label](uri)`), which the model pastes verbatim into its reply — pi's
Markdown renderer turns it into an OSC 8 hyperlink, so it stays clickable at any terminal
width (the URL is hidden on screen and the terminal reconstructs the link across soft
wraps). Raw OSC 8 sequences and bare URIs are deliberately not returned: a bare URI is
long, wraps on narrow screens, and Windows Terminal's URL auto-detection cannot join the
fragments. Each path is verified to exist on disk; a missing path gets a `! not found`
line so a misspelled filename is caught at cite time, before the link is delivered.

On `agent_end` the extension force-checks the delivered assistant text for `file://`
URIs Windows Terminal would reject (empty-host `file:///...` or `file://localhost`
with a non-drive first segment, i.e. Linux-side paths). When any leaked, it reports
rather than rewrites, delivering on `agent_settled` (the moment the run is fully
settled — sending during `agent_end` would otherwise be queued by pi as a steering
message): a one-line notify summary plus a chat custom message
(`>[!note] pi-cite-wslpath auto trans:` with the converted markdown links) rendered by
the same Markdown → OSC 8 pipeline as the chat body, so every link is clickable
regardless of terminal width. Quoted examples are skipped (code spans, fenced code
blocks, and `...` ellipsis forms), so citing the guideline text itself does not trip
the check.

## Configuration

Each gadget is enabled by default. Disable one in the user or project config:

```json
{
  "pi-cite-wslpath": { "status": "disabled" }
}
```

Configuration layers are merged from low to high priority:

```text
<package>/config.json
$PI_AGENT_DIR/pi-gadget/config.json      (or $PI_CODING_AGENT_DIR; default: ~/.pi/agent/pi-gadget/config.json)
$CWD/.pi/pi-gadget/config.json
```

The keys are `pi-clear`, `pi-exit`, and `pi-cite-wslpath`. A project setting overrides the user setting for the same key; omitted keys keep the lower-layer value. Changes take effect after `/reload`.

Use `/gadgets` to manage the current project's overrides:

```text
/gadgets list
/gadgets enable pi-cite-wslpath
/gadgets disable pi-cite-wslpath
/gadgets enable --global pi-cite-wslpath
/gadgets disable --global pi-cite-wslpath
```

`enable` and `disable` update `$CWD/.pi/pi-gadget/config.json` and reload the extensions. With `--global`, the command updates the agent directory config; when the current project already has a config file, it updates that file too so the project override does not mask the global setting. If the project config is absent, it is left absent. The management command remains available while individual gadgets are disabled.

## License

MIT
