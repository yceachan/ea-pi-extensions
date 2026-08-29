# pi-codex-imagegen

A [pi](https://github.com/earendil-works/pi) extension that delegates PNG generation to
the locally authenticated Codex CLI and its built-in `imagegen` capability.

Codex runs in an isolated temporary directory through a separately loaded
[`@yceachan/pi-shelld`](https://www.npmjs.com/package/@yceachan/pi-shelld) extension.
The ⭕shell monitor shows its live status, runtime, and log while the main agent keeps
working. The two packages are installed and loaded independently; pi-codex-imagegen does
not depend on or bundle pi-shelld.

## Install

Install both pi packages separately:

```bash
pi install npm:@yceachan/pi-shelld
pi install npm:@yceachan/pi-codex-imagegen
```

Local packages work the same way as long as both extensions are loaded into the same pi
process. Install Codex CLI and complete `codex login` first. The extension reuses that
local login and does not accept or store API keys.

## Tool

The extension registers `pi-codex-imagegen`:

```json
{
  "imagePrompt": "A system architecture overview showing the complete request lifecycle",
  "outputPath": "output/imagegen/architecture.png"
}
```

- `imagePrompt` passes the user's image intent, content, and style to Codex without requiring
  pi to rewrite it into a detailed generation recipe. Size belongs here only when relevant.
- `outputPath` is a required, non-existing `.png` destination, absolute or relative to
  pi's current working directory.
- Parent directories are created automatically; existing files are never overwritten.

The tool returns the pi-shelld shell ID immediately. Codex receives a short task in an
isolated temporary directory and owns the complete image-generation workflow, including
placing the final PNG at the fixed staging path `result.png`.

After Codex exits successfully, the extension copies `result.png` exclusively to
`outputPath`, removes the staging file, closes the shell record/log, removes the temporary
working directory, and posts completion to chat. There is no resize layer, generated-images
scan, final-response path protocol, or retained source copy.

If pi-shelld service v1 is not loaded, the tool fails before creating a temporary directory
or starting Codex and explains how to install or load pi-shelld.

## License

MIT
