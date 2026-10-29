import { afterEach, describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { CURSOR_MARKER, getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, colorToRgb, stripTerminalSequences, visibleWidth, TuiAltScreen, TuiMainScreen, type Terminal, type TerminalColors, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import sideChatExtension from "../srcs/index.ts";
import { SideChatOverlay } from "../srcs/side-chat-overlay.ts";
import { layoutTheme as theme } from "./theme-fixture.ts";

initTheme("dark");

// Real renderer/dispatch, in-memory terminal: no Pi process, model or clipboard.
class MemoryTerminal implements Terminal {
  columns = 120;
  rows = 40;
  kittyProtocolActive = false;
  writes: string[] = [];
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
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
function setup(mode: "fullscreen" | "regular" = "fullscreen", configureTui?: (tui: TuiAltScreen | TuiMainScreen) => void) {
  const terminal = new MemoryTerminal();
  const tui = mode === "fullscreen"
    ? new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 3 })
    : new TuiMainScreen(terminal);
  let mainInputs = "";
  tui.addChild({ render: () => ["main conversation"], invalidate() {}, handleInput: (data) => { mainInputs += data; } });
  tui.setFocus(tui.children[0]!);
  tui.start();
  configureTui?.(tui);
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const events = new Map<string, any>();
  sideChatExtension({
    on(name: string, handler: any) { events.set(name, handler); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut(key: string, spec: any) { shortcuts.set(key, spec.handler); },
    getThinkingLevel: () => "off",
  } as any);
  let overlay!: SideChatOverlay;
  let handle: ReturnType<TuiAltScreen["showOverlay"]>;
  const copies: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const models = [
    { id: "test-model", provider: "test", name: "Test", reasoning: false },
    { id: "reasoning-model", provider: "other", name: "Reasoner", reasoning: true },
  ];
  const ctx: any = {
    cwd: process.cwd(), model: models[0], modelRegistry: { getAvailable: () => models },
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    getSystemPrompt: () => "",
    ui: {
      setStatus(key: string, value: string | undefined) { statuses.set(key, value); tui.requestRender(); },
      notify() {},
      custom(factory: any, options: any) {
        return new Promise((resolve) => {
          overlay = factory(tui, theme, {}, (action: string) => { handle.hide(); resolve(action); });
          (overlay as any).options.copyText = async (text: string) => { copies.push(text); };
          (overlay as any).messages.setMessages([{ role: "user", content: "hello world", timestamp: 1 }]);
          handle = tui.showOverlay(overlay, options.overlayOptions);
          options.onHandle(handle);
        });
      },
    },
  };
  // /btw stays pending until its custom interaction closes.
  const closed = commands.get("btw").handler("", ctx);
  tui.renderNow();
  const fixture = {
    terminal, tui, overlay, copies, closed, ctx, statuses, models, events, commands,
    get handle() { return handle; },
    background: () => shortcuts.get("alt+w")(ctx),
    shortcuts,
    requestClose: () => commands.get("btw-close").handler("", ctx),
    get mainInputs() { return mainInputs; },
    get mainSelection() { return tui instanceof TuiAltScreen && tui.hasActiveSelection(); },
    mouse(button: number, x: number, y: number, release = false) {
      terminal.input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
    },
  };
  cleanups.push(async () => {
    overlay.dispose();
    await closed;
    events.get("session_shutdown")?.();
    tui.stop();
  });
  return fixture;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function chatPoint(f: ReturnType<typeof setup>, col: number, line = 1) {
  const b = f.handle.getBounds()!;
  return { x: b.col + 2 + col, y: b.row + (f.overlay as any).messageTop + line };
}
function selected(f: ReturnType<typeof setup>) { return (f.overlay as any).messages.getSelectedText() as string; }
function dragHello(f: ReturnType<typeof setup>) {
  const a = chatPoint(f, 2), b = chatPoint(f, 7);
  f.mouse(0, a.x, a.y);
  f.mouse(32, b.x, b.y);
  f.mouse(0, b.x, b.y, true);
}

const reporting = (writes: string[]) => writes.join("").match(/\x1b\[\?(?:1000|1002|1003|1006)[hl]/g) ?? [];

describe("panel colors and native navigation", () => {
  test("queries colors once, handles late/partial replies and unsubscribes on disposal", async () => {
    const queries: Array<{ resolve: (colors: TerminalColors) => void; late?: (colors: TerminalColors) => void }> = [];
    let scheme!: () => void;
    let unsubscribed = 0;
    const f = setup("fullscreen", (tui) => {
      tui.queryTerminalColors = (options) => new Promise((resolve) => { queries.push({ resolve, late: options.onLateReply }); });
      tui.onTerminalColorSchemeChange = (callback) => { scheme = () => callback("light"); return () => { unsubscribed++; }; };
    });
    f.overlay.render(100); f.overlay.render(100);
    expect(queries).toHaveLength(1);
    queries[0]!.resolve({}); await Promise.resolve();
    const palette = (f.overlay as any).palette;
    const fallback = palette.get(theme);
    queries[0]!.late?.({ background: { r: 30, g: 40, b: 65 } });
    const known = palette.get(theme);
    expect(colorToRgb(known.body)).not.toEqual(colorToRgb(fallback.body));
    scheme(); expect(queries).toHaveLength(2);
    queries[1]!.resolve({}); await Promise.resolve();
    expect(colorToRgb(palette.get(theme).body)).toEqual(colorToRgb(known.body));
    const latest = palette.get(theme);
    queries[0]!.late?.({ background: { r: 100, g: 10, b: 10 } });
    expect(palette.get(theme)).toBe(latest); // superseded query
    f.overlay.dispose(); await f.closed;
    expect(unsubscribed).toBe(1);
    queries[1]!.late?.({ background: { r: 100, g: 10, b: 10 } });
    expect(palette.get(theme)).toBe(latest); // disposed overlay
  });

  test("Ctrl+Up/Down jump messages without changing layout, draft or running agent; remaps work", () => {
    const original = getKeybindings();
    const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.altScreen.previousPrompt": ["ctrl+up"], "tui.altScreen.nextPrompt": ["ctrl+down"],
    });
    setKeybindings(bindings);
    try {
      const f = setup();
      const messages = (f.overlay as any).messages;
      messages.setMessages(Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `message ${i}`, timestamp: i })));
      (f.overlay as any).editor.setText("unsent draft");
      (f.overlay as any).isStreaming = true;
      f.tui.renderNow();
      const bounds = { ...f.handle.getBounds()! };
      const agent = (f.overlay as any).agent;
      f.terminal.input("\x1b[1;5A"); f.tui.renderNow();
      expect(messages.getScrollOffset()).toBeGreaterThan(0);
      f.terminal.input("\x1b[1;5B"); f.tui.renderNow();
      expect(messages.isAtBottom()).toBe(true);
      bindings.setUserBindings({ "tui.altScreen.previousPrompt": "alt+u", "tui.altScreen.nextPrompt": "alt+d" });
      f.terminal.input("\x1bu"); f.tui.renderNow();
      expect(messages.getScrollOffset()).toBeGreaterThan(0);
      f.terminal.input("\x1bd"); f.tui.renderNow();
      expect(messages.isAtBottom()).toBe(true);
      expect(f.handle.getBounds()).toEqual(bounds);
      expect((f.overlay as any).agent).toBe(agent);
      expect((f.overlay as any).isStreaming).toBe(true);
      expect((f.overlay as any).editor.getText()).toBe("unsent draft");
      (f.overlay as any).isStreaming = false;
    } finally { setKeybindings(original); }
  });
});

describe("side-chat lifecycle and settings", () => {
  test("Esc requests close; cancel and Alt+W preserve the running turn and draft", async () => {
    const f = setup();
    const agent = (f.overlay as any).agent;
    let aborts = 0;
    agent.abort = () => { aborts++; };
    (f.overlay as any).isStreaming = true;
    (f.overlay as any).editor.setText("draft");
    f.terminal.input("\x1b");
    expect(f.handle.isHidden()).toBe(false);
    expect((f.overlay as any).dialog).not.toBeNull();
    expect(aborts).toBe(0);
    f.terminal.input("\x1b"); // cancel confirmation
    await f.background();
    expect(f.handle.isHidden()).toBe(true);
    await f.background();
    expect(f.handle.isHidden()).toBe(false);
    expect((f.overlay as any).editor.getText()).toBe("draft");
    (f.overlay as any).isStreaming = false;
  });

  test("close from hidden chat restores a confirmation; default/cancel never closes", async () => {
    const f = setup();
    await f.background();
    await f.requestClose();
    expect(f.handle.isHidden()).toBe(false);
    expect(f.overlay.render(100).map(stripTerminalSequences).join("\n")).toContain("Close side chat?");
    f.terminal.input("\r"); // defaults to Keep
    expect((f.overlay as any).disposed).toBe(false);
    expect(f.shortcuts.has("ctrl+alt+w")).toBe(false);
    f.terminal.input("\x1b"); // Esc now owns close
    expect((f.overlay as any).dialog).not.toBeNull();
    f.terminal.input("\x1b"); // cancel confirmation, stay in the side chat
    expect(f.handle.isHidden()).toBe(false);
    expect((f.overlay as any).disposed).toBe(false);
    await f.commands.get("btw-close").handler("", f.ctx);
    f.terminal.input("\x1b[B");
    f.terminal.input("\r");
    await f.closed;
    expect((f.overlay as any).disposed).toBe(true);
    expect(f.statuses.get("pibtw.side-chat")).toBeUndefined();
  });

  for (const mode of ["fullscreen", "regular"] as const) {
    test(`${mode}: Alt+S stops a running turn inside help and close confirmation`, async () => {
      for (const modalKey of ["?", "\x1b"]) {
        const f = setup(mode);
        const agent = (f.overlay as any).agent;
        let finish!: () => void;
        let aborts = 0;
        agent.prompt = () => new Promise<void>((resolve) => { finish = resolve; });
        agent.abort = () => { aborts++; finish(); };
        const turn = (f.overlay as any).handleSubmit("question");
        f.terminal.input(modalKey);
        const dialog = (f.overlay as any).dialog;
        expect(dialog).not.toBeNull();
        f.terminal.input("\x1bs");
        expect(aborts).toBe(1);
        await turn;
        expect((f.overlay as any).isStreaming).toBe(false);
        expect((f.overlay as any).disposed).toBe(false);
        expect((f.overlay as any).agent).toBe(agent);
        expect((f.overlay as any).dialog).toBe(dialog);
        expect(f.statuses.get("pibtw.side-chat")).toContain("\x1b[32m●");
        expect(f.ctx.model.id).toBe("test-model");
      }
    });
  }

  for (const event of ["session_start", "session_shutdown"]) {
    test(`${event} tears down a hidden running chat without late status revival`, async () => {
      const f = setup();
      const agent = (f.overlay as any).agent;
      let finish!: () => void;
      let aborts = 0;
      agent.prompt = () => new Promise<void>((resolve) => { finish = resolve; });
      agent.abort = () => { aborts++; };
      const turn = (f.overlay as any).handleSubmit("question");
      await f.background();
      f.events.get(event)();
      await f.closed;
      expect(aborts).toBe(1);
      expect((f.overlay as any).disposed).toBe(true);
      expect(f.statuses.get("pibtw.side-chat")).toBeUndefined();
      finish();
      await turn;
      expect(f.statuses.get("pibtw.side-chat")).toBeUndefined();
    });
  }

  test("side model/thinking pickers leave main settings untouched and enforce supported levels", () => {
    const f = setup();
    const agent = (f.overlay as any).agent;
    f.terminal.input("\x1bm");
    f.terminal.input("reasoning");
    f.terminal.input("\r");
    expect(agent.state.model.id).toBe("reasoning-model");
    expect(f.ctx.model.id).toBe("test-model");
    f.terminal.input("\x1bt");
    f.terminal.input("\x1b[B");
    f.terminal.input("\r");
    expect(agent.state.thinkingLevel).not.toBe("off");
    f.terminal.input("\x1bm");
    f.terminal.input("test-model");
    f.terminal.input("\r");
    expect(agent.state.model.id).toBe("test-model");
    expect(agent.state.thinkingLevel).toBe("off");
    f.terminal.input("\x1bt");
    const text = f.overlay.render(100).map(stripTerminalSequences).join("\n");
    expect(text).toContain("does not support reasoning");
  });

  test("Esc returns from pickers; Alt+W still backgrounds an open picker", async () => {
    const f = setup();
    f.terminal.input("\x1bm");
    f.terminal.input("\x1b");
    expect(f.handle.isHidden()).toBe(false);
    expect((f.overlay as any).dialog).toBeNull();
    f.terminal.input("\x1bt");
    f.terminal.input("\x1bw");
    expect(f.handle.isHidden()).toBe(true);
    await f.background();
    f.terminal.input("\x1b");
    expect((f.overlay as any).dialog).toBeNull();
    expect((f.overlay as any).disposed).toBe(false);
  });

  test("Pi-style cycling wraps models and supported thinking without changing main settings", () => {
    const f = setup();
    const agent = (f.overlay as any).agent;
    f.terminal.input("\x10"); // Ctrl+P
    expect(agent.state.model.id).toBe("reasoning-model");
    f.terminal.input("\x1b[Z"); // Shift+Tab
    const firstThinking = agent.state.thinkingLevel;
    expect(firstThinking).not.toBe("off");
    for (let i = 1; i < getSupportedThinkingLevels(agent.state.model).length; i++) f.terminal.input("\x1b[Z");
    expect(agent.state.thinkingLevel).toBe("off");
    f.terminal.input("\x10");
    expect(agent.state.model.id).toBe("test-model");
    f.terminal.input("\x1b[Z");
    expect(agent.state.thinkingLevel).toBe("off");
    f.terminal.input("\x1bp"); // Windows backward alias
    expect(agent.state.model.id).toBe("reasoning-model");
    f.terminal.input("\x1b[112;6u"); // Ctrl+Shift+P
    expect(agent.state.model.id).toBe("test-model");
    expect(f.ctx.model.id).toBe("test-model");
    expect(f.mainInputs).toBe("");
  });

  test("model cycle follows Pi scoped order and per-model thinking, filtering unavailable models", () => {
    const f = setup();
    f.models.push({ id: "third", provider: "test", name: "Third", reasoning: false });
    f.ctx.scopedModels = [
      { model: f.models[0] },
      { model: { id: "unavailable", provider: "test" } },
      { model: f.models[1], thinkingLevel: "high" },
    ];
    f.terminal.input("\x10");
    expect((f.overlay as any).agent.state.model.id).toBe("reasoning-model");
    expect((f.overlay as any).agent.state.thinkingLevel).toBe("high");
    f.terminal.input("\x10");
    expect((f.overlay as any).agent.state.model.id).toBe("test-model");
    expect((f.overlay as any).agent.state.thinkingLevel).toBe("off");
    expect(f.ctx.model.id).toBe("test-model");
  });

  test("? opens help only on an empty draft; Esc returns and keeps the agent alive", () => {
    const f = setup();
    f.terminal.input("?");
    const lines = f.overlay.render(110);
    const text = lines.map(stripTerminalSequences).join("\n");
    expect(text).toContain("Side chat shortcuts");
    expect(text).toContain("Ctrl+P");
    expect(text).not.toContain("Ctrl+Alt+W");
    expect(lines.join("\n")).not.toContain("\x1b[97m");
    expect(text).toContain("Next model");
    f.terminal.input("\x1b");
    expect((f.overlay as any).dialog).toBeNull();
    expect((f.overlay as any).disposed).toBe(false);
    expect(f.handle.isHidden()).toBe(false);
    f.terminal.input("why");
    f.terminal.input("?");
    expect((f.overlay as any).editor.getText()).toBe("why?");
    expect((f.overlay as any).dialog).toBeNull();
  });

  test("short-terminal model picker keeps selected entries visible", () => {
    const f = setup();
    f.models.splice(0, f.models.length, ...Array.from({ length: 10 }, (_, i) => ({
      id: `model-${i}`, provider: "test", name: `Model ${i}`, reasoning: false,
    })));
    f.terminal.rows = 10;
    f.terminal.resize();
    f.terminal.input("\x1bm");
    for (let i = 0; i < 10; i++) {
      const lines = f.overlay.render(80);
      const selected = (f.overlay as any).dialog.list.getSelectedItem().label;
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(lines.map(stripTerminalSequences).join("\n")).toContain(selected);
      f.terminal.input("\x1b[B");
    }
  });

  test("selected virtual models stream through registry runtime, not compatibility/global auth", async () => {
    const f = setup();
    f.models.push({ id: "router", provider: "virtual", name: "Router", reasoning: true, api: "pi-virtual" } as any);
    const calls: string[] = [];
    f.ctx.modelRegistry.streamSimple = (model: any) => {
      calls.push(model.api);
      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: "assistant", content: [{ type: "text", text: "routed answer" }],
        api: "pi-virtual", provider: "virtual", model: "router", stopReason: "stop", timestamp: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    };
    f.terminal.input("\x1bm");
    f.terminal.input("router");
    f.terminal.input("\r");
    await (f.overlay as any).handleSubmit("hello");
    expect(calls).toEqual(["pi-virtual"]);
    expect((f.overlay as any).agent.state.errorMessage).toBeUndefined();
    expect(f.overlay.render(100).map(stripTerminalSequences).join("\n")).toContain("routed answer");
    expect(f.ctx.model.id).toBe("test-model");
  });

  test("model/thinking changes are blocked during a running turn", () => {
    const f = setup();
    (f.overlay as any).isStreaming = true;
    f.terminal.input("\x1bm");
    expect((f.overlay as any).dialog).toBeNull();
    f.terminal.input("\x1bt");
    f.terminal.input("\x10");
    f.terminal.input("\x1b[Z");
    expect((f.overlay as any).agent.state.model.id).toBe("test-model");
    expect((f.overlay as any).agent.state.thinkingLevel).toBe("off");
    expect((f.overlay as any).dialog).toBeNull();
    expect(f.overlay.render(100).map(stripTerminalSequences).join("\n")).toContain("Alt+S");
    (f.overlay as any).isStreaming = false;
  });

  test("busy status survives hiding and returns green on completion", async () => {
    const f = setup();
    const agent = (f.overlay as any).agent;
    let finish!: () => void;
    agent.prompt = () => new Promise<void>((resolve) => { finish = resolve; });
    const turn = (f.overlay as any).handleSubmit("hello");
    await f.background();
    await Bun.sleep(120);
    expect(f.statuses.get("pibtw.side-chat")).toContain("\x1b[33m●");
    finish();
    await turn;
    await Bun.sleep(120);
    expect(f.statuses.get("pibtw.side-chat")).toContain("\x1b[32m●");
  });

  test("confirmed close aborts a running turn and late completion never revives status", async () => {
    const f = setup();
    const agent = (f.overlay as any).agent;
    let finish!: () => void;
    let aborts = 0;
    agent.prompt = () => new Promise<void>((resolve) => { finish = resolve; });
    agent.abort = () => { aborts++; };
    const turn = (f.overlay as any).handleSubmit("hello");
    expect(f.statuses.get("pibtw.side-chat")).toContain("\x1b[33m●");
    f.terminal.input("\x1b");
    expect(aborts).toBe(0);
    f.terminal.input("\x1b[B");
    f.terminal.input("\r");
    await f.closed;
    expect(aborts).toBe(1);
    expect(f.statuses.get("pibtw.side-chat")).toBeUndefined();
    finish();
    await turn;
    expect(f.statuses.get("pibtw.side-chat")).toBeUndefined();
  });

  test("borderless surfaces fill every cell in dark/light and narrow layouts", () => {
    const f = setup();
    try {
      for (const appearance of ["dark", "light"]) {
        initTheme(appearance);
        f.overlay.invalidate();
        for (const width of [40, 80, 102]) {
          const lines = f.overlay.render(width);
          expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
          expect(lines.every((line) => /\x1b\[48;(?:2|5);/.test(line))).toBe(true);
          expect(lines.map(stripTerminalSequences).join("\n")).not.toMatch(/[┌┐└┘─]/);
          expect(lines.map(stripTerminalSequences).join("\n")).toContain("│ hello world");
          const { top } = (f.overlay as any).editorLayout;
          const backgrounds = lines[top].match(/\x1b\[48;[^m]+m/g)!;
          expect(new Set(backgrounds).size).toBeGreaterThan(1); // panel margins surround the inset input
          expect(backgrounds[0]).toBe(lines[0].match(/\x1b\[48;[^m]+m/)![0]!);
          expect(backgrounds.at(-1)).toBe(backgrounds[0]!);
        }
      }
    } finally { initTheme("dark"); }
  });
});

describe("live layout presets", () => {
  for (const mode of ["fullscreen", "regular"] as const) {
    test(`${mode}: Ctrl+Alt+arrows change real bounds, retaining a running agent, multiline draft and mouse selection`, async () => {
      const f = setup(mode);
      const agent = (f.overlay as any).agent, editor = (f.overlay as any).editor;
      const messages = (f.overlay as any).messages;
      const draft = "line one\nline two\nline three\nline four";
      editor.setText(draft);
      (f.overlay as any).isStreaming = true;
      for (const [key, col, row, width, height] of [
        ["\x1b[1;7D", 0, 0, 120, 40],
        ["\x1b[1;7A", 9, 1, 102, 17],
        ["\x1b[1;7C", 60, 0, 60, 40],
        ["\x1b[1;7B", 6, 2, 108, 36],
        ["\x1b[1;7D", 0, 0, 120, 40],
      ] as const) {
        messages.setSelection({ line: 0, col: 7 }, { line: 0, col: 12 });
        f.terminal.input(key); f.tui.renderNow();
        expect(f.handle.getBounds()).toMatchObject({ col, row, width, height });
        expect((f.overlay as any).agent).toBe(agent);
        expect((f.overlay as any).editor).toBe(editor);
        expect((f.overlay as any).messages).toBe(messages);
        expect(editor.getText()).toBe(draft);
        expect((f.overlay as any).isStreaming).toBe(true);
        expect(messages.hasSelection()).toBe(false);
        const frame = f.overlay.render(width);
        expect(frame).toHaveLength(height);
        expect(frame.every((line) => visibleWidth(line) === width)).toBe(true);
        const text = frame.map(stripTerminalSequences);
        expect(text[height < 18 ? 0 : 1]).toContain("Side Chat");
        expect(text[height < 18 ? 0 : 1]).toContain("test/test-");
        expect(text.filter((line) => line.includes("test/test-"))).toHaveLength(1);
        expect(text.join("\n")).toContain("line four");
        expect(text.at(height < 18 ? -1 : -2)).toContain("Enter send");
        dragHello(f); expect(selected(f)).toBe("hello");
      }
      await f.background(); await f.background(); f.tui.renderNow();
      expect(f.handle.getBounds()).toMatchObject({ width: 120, height: 40 });
      expect(editor.getText()).toBe(draft);
      (f.overlay as any).isStreaming = false;
    });

    test(`${mode}: very short overlays retain the multiline cursor and keyboard/native mouse editing`, () => {
      const f = setup(mode);
      const editor = (f.overlay as any).editor;
      const draft = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
      f.terminal.columns = 40; f.terminal.rows = 8; f.terminal.resize();
      for (const key of ["\x1b[1;7B", "\x1b[1;7A", "\x1b[1;7D", "\x1b[1;7C"]) {
        editor.setText(draft);
        f.terminal.input(key); f.tui.renderNow();
        const bounds = f.handle.getBounds()!;
        const frame = f.overlay.render(bounds.width);
        expect(frame).toHaveLength(bounds.height);
        expect(frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
        expect(frame.map(stripTerminalSequences).join("\n")).toContain("line 10");
        expect(editor.getText()).toBe(draft);
        const ninthRow = frame.findIndex((line) => stripTerminalSequences(line).includes("line 9"));
        expect(ninthRow).toBeGreaterThanOrEqual(0);
        if (mode === "fullscreen") {
          // Only Pi's fullscreen renderer dispatches native editor clicks.
          const x = bounds.col + (f.overlay as any).editorLayout.left;
          f.mouse(0, x, bounds.row + ninthRow);
          f.mouse(0, x, bounds.row + ninthRow, true);
          expect(editor.getCursor()).toEqual({ line: 8, col: 0 });
        } else {
          f.terminal.input("\x1b[A");
          expect(editor.getCursor().line).toBe(8);
        }
        expect(editor.getText()).toBe(draft);
      }
    });

    test(`${mode}: presets work inside help and remain bounded after small/odd terminal resize`, () => {
      const f = setup(mode);
      f.terminal.input("?"); const help = (f.overlay as any).dialog;
      f.terminal.input("\x1b[1;7C"); f.tui.renderNow();
      expect((f.overlay as any).dialog).toBe(help);
      expect(f.handle.getBounds()).toMatchObject({ col: 60, row: 0, width: 60, height: 40 });
      f.terminal.input("\x1b"); // back from help, never close the agent
      for (const [columns, rows] of [[81, 30], [61, 10], [40, 8]]) {
        f.terminal.columns = columns!; f.terminal.rows = rows!; f.terminal.resize();
        for (const key of ["\x1b[1;7D", "\x1b[1;7A", "\x1b[1;7C", "\x1b[1;7B"]) {
          f.terminal.input(key); f.tui.renderNow();
          const bounds = f.handle.getBounds()!;
          expect(bounds.col).toBeGreaterThanOrEqual(0); expect(bounds.row).toBeGreaterThanOrEqual(0);
          expect(bounds.col + bounds.width).toBeLessThanOrEqual(columns!);
          expect(bounds.row + bounds.height).toBeLessThanOrEqual(rows!);
          const frame = f.overlay.render(bounds.width);
          expect(frame.length).toBeLessThanOrEqual(rows!);
          expect(frame.every((line) => visibleWidth(line) <= bounds.width)).toBe(true);
        }
      }
    });
  }
});

describe("Pi 1.0 fullscreen overlay dispatch", () => {
  test("regular mode retains SGR selection and visibility-bound reporting", async () => {
    const f = setup("regular");
    expect(reporting(f.terminal.writes)).toContain("\x1b[?1002h");
    dragHello(f);
    expect(selected(f)).toBe("hello");
    f.terminal.writes = [];
    await f.background();
    expect(reporting(f.terminal.writes)).toContain("\x1b[?1002l");
    await f.background();
    expect(reporting(f.terminal.writes)).toContain("\x1b[?1002h");
    f.terminal.writes = [];
    f.overlay.dispose();
    await f.closed;
    expect(reporting(f.terminal.writes)).toContain("\x1b[?1002l");
  });
  test("SGR drag reaches native handler; hotkey copies only the chat selection", async () => {
    const f = setup();
    dragHello(f);
    expect(selected(f)).toBe("hello");
    expect(f.mainSelection).toBe(false);
    expect(f.copies).toEqual([]);
    f.terminal.input("\x03");
    await Promise.resolve();
    expect(f.copies).toEqual(["hello"]);
    f.tui.renderNow();
    expect(selected(f)).toBe("hello");
    f.terminal.input("\x1b[99;6u");
    await Promise.resolve();
    expect(f.copies).toEqual(["hello", "hello"]);
  });

  test("press focuses the overlay; a double click selects the whole line", () => {
    const f = setup();
    f.handle.unfocus();
    const p = chatPoint(f, 8);
    f.mouse(0, p.x, p.y); f.mouse(0, p.x, p.y, true);
    expect(f.handle.isFocused()).toBe(true);
    f.mouse(0, p.x, p.y); f.mouse(0, p.x, p.y, true);
    expect(selected(f).trimStart()).toBe("hello world");
    expect(f.copies).toEqual([]);
  });

  test("capture retains an out-of-bounds drag, including the last column", () => {
    const f = setup();
    const width = f.handle.getBounds()!.width - 4;
    (f.overlay as any).messages.setMessages([{ role: "user", content: "x".repeat(width - 7), timestamp: 1 }]);
    f.tui.renderNow();
    const p = chatPoint(f, 2);
    f.mouse(0, p.x, p.y);
    f.mouse(32, 119, p.y);
    f.mouse(0, 119, p.y, true);
    expect(selected(f)).toBe("x".repeat(width - 7));
    expect(f.overlay.isMouseDragging()).toBe(false);
    expect(f.mainSelection).toBe(false);
  });

  test("wheel uses Pi's logical delta and frame clicks do not select the main transcript", () => {
    const f = setup();
    const messages = (f.overlay as any).messages;
    messages.setMessages(Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `message ${i}`, timestamp: i })));
    f.tui.renderNow();
    const p = chatPoint(f, 7);
    f.mouse(64, p.x, p.y);
    expect(messages.getScrollOffset()).toBe(3);
    f.mouse(65, p.x, p.y);
    expect(messages.getScrollOffset()).toBe(0);
    const b = f.handle.getBounds()!;
    f.mouse(0, b.col + 1, b.row + 1);
    f.mouse(32, b.col + 8, b.row + 1);
    f.mouse(0, b.col + 8, b.row + 1, true);
    expect(f.mainSelection).toBe(false);
    expect(selected(f)).toBe("");
  });

  test("release with no button and mid-drag modifiers still ends capture", () => {
    const f = setup();
    const a = chatPoint(f, 2), b = chatPoint(f, 7);
    f.mouse(0, a.x, a.y);
    f.mouse(32 | 16, b.x, b.y);
    f.mouse(3 | 16, b.x, b.y, true);
    expect(selected(f)).toBe("hello");
    expect(f.overlay.isMouseDragging()).toBe(false);
  });

  test("editor click positions the cursor and keeps overlay keyboard ownership", () => {
    const f = setup();
    dragHello(f);
    const editor = (f.overlay as any).editor;
    editor.setText("你好 world");
    f.tui.renderNow();
    const b = f.handle.getBounds()!;
    const y = b.row + (f.overlay as any).editorLayout.top;
    const frame = f.overlay.render(b.width).map(stripTerminalSequences);
    expect(frame[(f.overlay as any).editorLayout.top]).toContain("你好 world");
    const x = b.col + (f.overlay as any).editorLayout.left + 5;
    f.mouse(0, x, y); f.mouse(0, x, y, true);
    expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
    expect(selected(f)).toBe("");
    expect(f.handle.isFocused()).toBe(true);
    f.terminal.input("X");
    expect(editor.getText()).toBe("你好 Xworld");
    expect(f.mainInputs).toBe("");
  });

  test("selection follows dispatched local geometry after resize and alternate placement", () => {
    const f = setup();
    f.terminal.columns = 80;
    f.terminal.resize();
    f.tui.renderNow();
    dragHello(f);
    expect(selected(f)).toBe("hello");
    const width = 60;
    f.overlay.render(width);
    const event: TuiMouseEvent = {
      type: "press", button: "left", x: 4, y: (f.overlay as any).messageTop + 1,
      screenX: 9, screenY: 13, width, height: 25,
      shift: false, alt: false, ctrl: false,
    };
    f.overlay.handleMouse(event);
    f.overlay.handleMouse({ ...event, type: "drag", x: 9, screenX: 14 });
    f.overlay.handleMouse({ ...event, type: "release", x: 9, screenX: 14 });
    expect(selected(f)).toBe("hello");
  });

  test("background, restore and close leave host mouse reporting intact", async () => {
    const f = setup();
    const p = chatPoint(f, 7);
    f.mouse(0, p.x, p.y);
    expect(f.overlay.isMouseDragging()).toBe(true);
    f.terminal.writes = [];
    await f.background();
    expect(f.overlay.isMouseDragging()).toBe(false);
    expect(f.handle.isHidden()).toBe(true);
    f.terminal.input("main");
    expect(f.mainInputs).toBe("main");
    await f.background();
    expect(f.handle.isFocused()).toBe(true);
    f.overlay.dispose();
    await f.closed;
    expect(reporting(f.terminal.writes)).toEqual([]);
    expect(f.tui.hasOverlay()).toBe(false);
  });
});
