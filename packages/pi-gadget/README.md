# pi-gadget

A small collection of single-file [pi](https://github.com/earendil-works/pi) extensions — handy
gadgets, each living in one file:

- **`/clear`** — archive the current session (moves it out of the way while keeping it resumable)
- **`/exit`** — exit pi cleanly

## Install

```bash
pi install npm:@yceachan/pi-gadget
```

## Usage

Run `/clear` to archive the active session, `/exit` to quit pi. Both commands are plain
slash-command extensions; see the source files for exact behavior.

## License

MIT
