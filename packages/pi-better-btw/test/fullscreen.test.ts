import { afterEach, describe, expect, test } from "bun:test";
import { TuiAltScreen, TuiMainScreen, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import sideChatExtension from "../srcs/index.ts";
import { SideChatOverlay } from "../srcs/side-chat-overlay.ts";

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
}

const theme: any = { fg: (_name: string, text: string) => text };
const cleanups: Array<() => Promise<void>> = [];
function setup(mode: "fullscreen" | "regular" = "fullscreen") {
  const terminal = new MemoryTerminal();
  const tui = mode === "fullscreen"
    ? new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 3 })
    : new TuiMainScreen(terminal);
  let mainInputs = "";
  tui.addChild({ render: () => ["main conversation"], invalidate() {}, handleInput: (data) => { mainInputs += data; } });
  tui.setFocus(tui.children[0]!);
  tui.start();
  const commands = new Map<string, any>();
  let shortcut: any;
  sideChatExtension({
    on() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut(_key: string, spec: any) { shortcut = spec.handler; },
    getThinkingLevel: () => "off",
  } as any);
  let overlay!: SideChatOverlay;
  let handle: ReturnType<TuiAltScreen["showOverlay"]>;
  const copies: string[] = [];
  const ctx: any = {
    cwd: process.cwd(), model: { id: "test-model" }, modelRegistry: {},
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    getSystemPrompt: () => "",
    ui: {
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
    terminal, tui, overlay, copies, closed,
    get handle() { return handle; },
    background: () => shortcut(ctx),
    get mainInputs() { return mainInputs; },
    get mainSelection() { return tui instanceof TuiAltScreen && tui.hasActiveSelection(); },
    mouse(button: number, x: number, y: number, release = false) {
      terminal.input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
    },
  };
  cleanups.push(async () => {
    overlay.dispose();
    await closed;
    tui.stop();
  });
  return fixture;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function chatPoint(f: ReturnType<typeof setup>, col: number, line = 0) {
  const b = f.handle.getBounds()!;
  return { x: b.col + 2 + col, y: b.row + 3 + line };
}
function selected(f: ReturnType<typeof setup>) { return (f.overlay as any).messages.getSelectedText() as string; }
function dragHello(f: ReturnType<typeof setup>) {
  const a = chatPoint(f, 7), b = chatPoint(f, 12);
  f.mouse(0, a.x, a.y);
  f.mouse(32, b.x, b.y);
  f.mouse(0, b.x, b.y, true);
}

const reporting = (writes: string[]) => writes.join("").match(/\x1b\[\?(?:1000|1002|1003|1006)[hl]/g) ?? [];

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
    expect(selected(f)).toBe("[You]: hello world");
    expect(f.copies).toEqual([]);
  });

  test("capture retains an out-of-bounds drag, including the last column", () => {
    const f = setup();
    const width = f.handle.getBounds()!.width - 4;
    (f.overlay as any).messages.setMessages([{ role: "user", content: "x".repeat(width - 7), timestamp: 1 }]);
    f.tui.renderNow();
    const p = chatPoint(f, 7);
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
    const a = chatPoint(f, 7), b = chatPoint(f, 12);
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
    const y = b.row + (f.overlay as any).editorLayout.top + 1;
    const x = b.col + 2 + 5;
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
      type: "press", button: "left", x: 9, y: 3,
      screenX: 14, screenY: 13, width, height: 25,
      shift: false, alt: false, ctrl: false,
    };
    f.overlay.handleMouse(event);
    f.overlay.handleMouse({ ...event, type: "drag", x: 14, screenX: 19 });
    f.overlay.handleMouse({ ...event, type: "release", x: 14, screenX: 19 });
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
