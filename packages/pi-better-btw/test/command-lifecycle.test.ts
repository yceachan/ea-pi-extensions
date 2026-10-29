import { afterEach, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Editor, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import sideChatExtension from "../srcs/index.ts";
import type { SideChatOverlay } from "../srcs/side-chat-overlay.ts";

// Exercise the actual SDK submit/dispatch/custom methods without a Pi process or model.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", entry).href);
const { AgentSession } = await import(new URL("./core/agent-session.js", entry).href);
const { getEditorTheme } = await import(new URL("./modes/interactive/theme/theme.js", entry).href);
initTheme("dark");

class MemoryTerminal implements Terminal {
  columns = 120;
  rows = 40;
  kittyProtocolActive = false;
  input = (_data: string) => {};
  start(input: (data: string) => void) { this.input = input; }
  stop() {}
  async drainInput() {}
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = () => Bun.sleep(0);

function setup(mode: "fullscreen" | "regular" = "fullscreen") {
  const terminal = new MemoryTerminal();
  const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const commands = new Map<string, any>(), shortcuts = new Map<string, any>(), events = new Map<string, any>();
  sideChatExtension({
    on: (name: string, handler: any) => events.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: (key: string, spec: any) => shortcuts.set(key, spec.handler),
    getThinkingLevel: () => "off",
  } as any);
  const editor = new Editor(tui, getEditorTheme());
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();
  const host: any = Object.create(InteractiveMode.prototype);
  Object.assign(host, { ui: tui, editor, defaultEditor: editor, pendingUserInputs: [], keybindings: {}, flushPendingBashComponents() {} });
  const overlays: SideChatOverlay[] = [], handles: any[] = [], notices: string[] = [];
  let failInteraction!: (error: Error) => void;
  let exits = 0;
  const ctx: any = {
    cwd: process.cwd(), model: { id: "test", provider: "test", reasoning: false },
    modelRegistry: { getAvailable: () => [] },
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    getSystemPrompt: () => "", shutdown() { exits++; },
    ui: {
      notify(message: string) { notices.push(message); }, setStatus() {},
      custom(factory: any, options: any) {
        const interaction = host.showExtensionCustom((...args: any[]) => {
          const overlay = factory(...args);
          overlays.push(overlay);
          return overlay;
        }, { ...options, onHandle(handle: any) { handles.push(handle); options.onHandle(handle); } });
        // Injectable host UI failure, including failures after a successful mount.
        return Promise.race([interaction, new Promise((_resolve, reject) => { failInteraction = reject; })]);
      },
    },
  };
  commands.set("exit", { handler: async () => ctx.shutdown() });
  const runner = {
    getCommand: (name: string) => commands.get(name), createCommandContext: () => ctx,
    emitError(error: any) { notices.push(error.error); },
  };
  host.runtimeHost = { session: {
    isCompacting: false, isStreaming: false,
    prompt: (text: string) => AgentSession.prototype._tryExecuteExtensionCommand.call({ _extensionRunner: runner }, text),
  } };
  host.setupEditorSubmitHandler();
  const processed: string[] = [];
  let stopped = false;
  // The serialized boundary in InteractiveMode.run: getUserInput -> await session.prompt.
  const pump = (async () => {
    while (!stopped) {
      const input = await host.getUserInput();
      if (stopped) break;
      await host.session.prompt(input);
      processed.push(input);
    }
  })();
  cleanups.push(async () => {
    stopped = true;
    events.get("session_shutdown")();
    host.onInputCallback?.("");
    await pump;
    tui.stop();
  });
  return {
    terminal, tui, ctx, commands, overlays, handles, notices, processed, host,
    get exits() { return exits; },
    submit: (text: string) => editor.onSubmit!(text),
    background: () => shortcuts.get("alt+w")(ctx),
    fail: (error: Error) => failInteraction(error),
    event: (name: string) => events.get(name)(),
  };
}

for (const mode of ["fullscreen", "regular"] as const) {
  test(`${mode}: hidden /btw releases the host queue; repeated opens restore one session and /exit dispatches`, async () => {
    const f = setup(mode);
    await f.submit("/btw");
    await tick();
    expect(f.processed).toEqual(["/btw"]);
    expect(f.overlays).toHaveLength(1);
    const overlay: any = f.overlays[0];
    overlay.editor.setText("retained draft");
    for (const command of ["/btw", "/side", "/btw"]) {
      await f.background();
      expect(f.handles[0].isHidden()).toBe(true);
      await f.submit(command);
      await tick();
      expect(f.handles[0].isHidden()).toBe(false);
      expect(f.overlays).toHaveLength(1);
      expect(overlay.editor.getText()).toBe("retained draft");
    }
    await f.background();
    await f.submit("/exit");
    await tick();
    expect(f.exits).toBe(1);
    expect(f.processed).toEqual(["/btw", "/btw", "/side", "/btw", "/exit"]);
    expect(f.host.pendingUserInputs).toEqual([]);
    expect(f.notices).toEqual([]);
  });
}

test("concurrent opens share asynchronous mounting and preserve initial errors", async () => {
  const f = setup();
  const opened = f.commands.get("btw").handler("", f.ctx);
  const again = f.commands.get("side").handler("", f.ctx);
  await Promise.all([opened, again]);
  expect(f.overlays).toHaveLength(1);
  f.event("session_shutdown");
  const custom = f.ctx.ui.custom;
  f.ctx.ui.custom = async () => { throw new Error("mount failed"); };
  await expect(f.commands.get("btw").handler("", f.ctx)).rejects.toThrow("mount failed");
  f.ctx.ui.custom = custom;
  await f.commands.get("btw").handler("", f.ctx);
  expect(f.overlays).toHaveLength(2);
});

test("failure after factory creation rejects mounting and releases allocated UI resources", async () => {
  const f = setup();
  const custom = f.ctx.ui.custom;
  f.ctx.ui.custom = (factory: any, options: any) => custom(factory, {
    ...options, onHandle() { throw new Error("handle setup failed"); },
  });
  await expect(f.commands.get("btw").handler("", f.ctx)).rejects.toThrow("handle setup failed");
  expect((f.overlays[0] as any).disposed).toBe(true);
  expect(f.tui.hasOverlay()).toBe(false);
  f.ctx.ui.custom = custom;
  await f.commands.get("btw").handler("", f.ctx);
  expect(f.overlays).toHaveLength(2);
});

test("post-mount failures are reported and dispose the failed interaction", async () => {
  const f = setup();
  await f.commands.get("btw").handler("", f.ctx);
  f.fail(new Error("host UI failed"));
  await tick();
  expect(f.notices).toEqual(["Side chat failed: host UI failed"]);
  expect((f.overlays[0] as any).disposed).toBe(true);
  await f.commands.get("btw").handler("", f.ctx);
  expect(f.overlays).toHaveLength(2);
});

for (const event of ["session_start", "session_shutdown"]) {
  test(`${event} prevents a pending Alt+N restart from reviving the chat`, async () => {
    const f = setup();
    await f.commands.get("btw").handler("", f.ctx);
    f.terminal.input("\x1bn");
    f.event(event);
    await tick();
    expect(f.overlays).toHaveLength(1);
    expect((f.overlays[0] as any).disposed).toBe(true);
    expect(f.tui.hasOverlay()).toBe(false);
  });
}

test("Alt+N discards history, keeps model settings and returns a usable command loop", async () => {
  const f = setup();
  await f.submit("/btw");
  await tick();
  const old: any = f.overlays[0];
  old.agent.state.messages.push({ role: "user", content: "old side-session question", timestamp: 1 });
  old.agent.state.thinkingLevel = "low";
  old.options.onSettingsChange(old.agent.state.model, "low");
  f.terminal.input("\x1bn");
  await tick();
  expect(f.overlays).toHaveLength(2);
  const fresh: any = f.overlays[1];
  expect(old.disposed).toBe(true);
  expect(fresh.agent).not.toBe(old.agent);
  expect(JSON.stringify(fresh.agent.state.messages)).not.toContain("old side-session question");
  expect(fresh.agent.state.thinkingLevel).toBe("low");
  await f.background();
  await f.submit("/exit");
  await tick();
  expect(f.exits).toBe(1);
  expect(f.host.pendingUserInputs).toEqual([]);
});
