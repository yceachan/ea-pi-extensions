# pi-gadget

A small collection of single-file [pi](https://github.com/earendil-works/pi) extensions — handy
gadgets, each living in one file:

- **`/clear`** — archive the current session (moves it out of the way while keeping it resumable)
- **`/exit`** — exit pi cleanly
- **`pi_cite_wslpath`** — tool for the model: converts a native (WSL) path into Windows-Terminal-openable hyperlink text (OSC 8 / markdown / plain URI), because `file:///home/...` / `file:///mnt/c/...` links are rejected by Windows Terminal

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

## License

MIT
