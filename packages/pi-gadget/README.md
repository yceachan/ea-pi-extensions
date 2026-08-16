# pi-gadget

A small collection of single-file [pi](https://github.com/earendil-works/pi) extensions — handy
gadgets, each living in one file:

- **`/clear`** — archive the current session (moves it out of the way while keeping it resumable)
- **`/exit`** — exit pi cleanly
- **`pi_cite_wslpath`** — tool for the model: converts native (WSL) paths into Windows-Terminal-openable hyperlink text (OSC 8 / markdown / plain URI), because `file:///home/...` / `file:///mnt/c/...` links are rejected by Windows Terminal. Takes a `paths[]` batch in one call; an `agent_end` hook force-checks every delivered reply for un-converted links and warns with the converted forms

## Install

```bash
pi install npm:@yceachan/pi-gadget
```

## Usage

Run `/clear` to archive the active session, `/exit` to quit pi. Both commands are plain
slash-command extensions; see the source files for exact behavior.

`pi_cite_wslpath` is a tool the model calls to cite file paths clickable in Windows
Terminal (Ctrl+click). Conversion rules: `/mnt/<drive>/...` → `file:///<DRIVE>:/...`,
other Linux paths → `file://wsl.localhost/<distro>/...` (Windows Terminal ≥ 1.17).
Outside WSL it falls back to the standard `file://` URI.

The tool takes a `paths` array (one or more native paths) plus an optional `form`
(`both` | `osc8` | `markdown`), and returns label/uri/osc8/markdown for each path in a
single tool result — batch several files into one call instead of one call per path.
Each path is verified to exist on disk; a missing path gets a `! not found` line so a
misspelled filename is caught at cite time, before the link is delivered.

On `agent_end` the extension force-checks the delivered assistant text for `file://`
URIs Windows Terminal would reject (empty-host `file:///...` or `file://localhost`
with a non-drive first segment, i.e. Linux-side paths). When any leaked, it shows a
warning notification with the converted markdown links, so a missed cite call can no
longer slip through silently. Quoted examples are skipped (code spans, fenced code
blocks, and `...` ellipsis forms), so citing the guideline text itself does not trip
the check.

## License

MIT
