import { afterEach, describe, expect, test } from "bun:test";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { CopyResult } from "../clipboard.ts";
import type { BufferState, ChatMessage, ServerState } from "../types.ts";
import { ChatPane } from "./ChatPane.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { logLine } from "./chatCopy.ts";
import { useSelectionCopy } from "./useSelectionCopy.ts";

const at = (min: number) => new Date(2026, 10, 27, 14, min);

const MESSAGES: ChatMessage[] = [
  { id: "a", timestamp: at(2), kind: "message", from: "kai", text: "0.9.8 adds renderer-wide selection colors" },
  // Grouped under kai's first line: drawn with no time and no nick.
  { id: "b", timestamp: at(3), kind: "message", from: "kai", text: "café Привет 🎉 done" },
  { id: "c", timestamp: at(4), kind: "action", from: "fern", text: "waves" },
  // U+202E would make "gpj.exe" show as "exe.jpg" where the text is pasted.
  { id: "d", timestamp: at(5), kind: "message", from: "eve", text: "photo\u202Egpj.exe" },
];

type Rendered = Awaited<ReturnType<typeof testRender>>;

interface Harness extends Pick<Rendered, "mockMouse" | "mockInput" | "renderer"> {
  copies: string[];
  /** Keys that got past the copy listener to the rest of the app. */
  keys: string[];
  /** Lines sent from the input. */
  sent: string[];
  screen: string[];
}

/** A connected server, where your nick is "me", with one #honk buffer. */
function serverWith(buffer: BufferState): ServerState {
  return {
    id: "test",
    name: "test",
    config: { id: "test", host: "127.0.0.1", nick: "me" },
    status: "connected",
    nick: "me",
    tls: false,
    buffers: { "#honk": buffer },
    bufferOrder: ["#honk"],
  };
}

/** A clipboard that keeps what it was given. */
function recordingCopy(copies: string[]) {
  return async (text: string): Promise<CopyResult> => {
    copies.push(text);
    return "copied";
  };
}

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

/**
 * The chat pane inside a screen-wide box that copies on release, as in App.
 * Narrow, so kai's first line wraps.
 */
async function setup(
  options: { topic?: string; inputFocused?: boolean; firstUnreadId?: string } = {},
): Promise<Harness> {
  const copies: string[] = [];
  const keys: string[] = [];
  const sent: string[] = [];
  const buffer: BufferState = {
    name: "#honk",
    kind: "channel",
    topic: options.topic ?? "",
    firstUnreadId: options.firstUnreadId,
    messages: MESSAGES,
    users: [],
    unread: 0,
    hasMention: false,
  };
  const server = serverWith(buffer);
  const copyText = recordingCopy(copies);
  const onCopied = () => {};
  function Screen() {
    const onMouseUp = useSelectionCopy(copyText, onCopied);
    // As in App: a key that the copy handled is skipped.
    useKeyboard((key) => {
      if (!key.defaultPrevented) keys.push(key.ctrl ? `ctrl+${key.name}` : key.name);
    });
    return (
      <box width="100%" height="100%" onMouseUp={onMouseUp}>
        <ChatPane
          server={server}
          buffer={buffer}
          inputFocused={options.inputFocused ?? false}
          paneWidth={50}
          onSubmit={(line) => sent.push(line)}
          onPasteLines={() => {}}
          onSelectUser={() => {}}
          onJoinChannel={() => {}}
        />
      </box>
    );
  }
  // As in src/index.tsx: honk quits on Ctrl+C itself, the renderer does not.
  const r = await testRender(<Screen />, { width: 50, height: 18, exitOnCtrlC: false });
  destroy = () => act(() => r.renderer.destroy());
  await r.renderOnce();
  const screen = r.captureCharFrame().split("\n");
  return { copies, keys, sent, screen, mockMouse: r.mockMouse, mockInput: r.mockInput, renderer: r.renderer };
}

/** The cell of `text` on `screen`, plus `dx` cells. */
function cellOf(screen: string[], text: string, dx = 0) {
  for (let y = 0; y < screen.length; y++) {
    const x = screen[y]!.indexOf(text);
    if (x !== -1) return { x: x + dx, y };
  }
  throw new Error(`"${text}" is not on screen:\n${screen.join("\n")}`);
}

/** Lets the copy's promise settle. */
const settle = () => act(() => Promise.resolve());

describe("copy on release", () => {
  test("a drag across messages copies one log line per message, with the time and nick of each", async () => {
    const { copies, screen, mockMouse } = await setup();
    // kai's first line wraps, so the drag starts on its first screen row.
    const from = cellOf(screen, "0.9.8");
    const to = cellOf(screen, "waves", 4);
    await act(() => mockMouse.drag(from.x, from.y, to.x, to.y));
    await settle();
    expect(copies).toEqual([
      [
        "14:02 <kai> 0.9.8 adds renderer-wide selection colors",
        "14:03 <kai> café Привет 🎉 done",
        "14:04 * fern waves",
      ].join("\n"),
    ]);
  });

  test("a drag inside one message copies only the selected part of the body", async () => {
    const { copies, screen, mockMouse } = await setup();
    const from = cellOf(screen, "Привет");
    const to = cellOf(screen, "🎉", 1);
    await act(() => mockMouse.drag(from.x, from.y, to.x, to.y));
    await settle();
    expect(copies).toEqual(["Привет 🎉"]);
  });

  test("a double-click copies the word, and a triple-click the whole message", async () => {
    const { copies, screen, mockMouse } = await setup();
    const word = cellOf(screen, "colors", 2);
    await act(() => mockMouse.click(word.x, word.y));
    await act(() => mockMouse.click(word.x, word.y));
    await settle();
    expect(copies).toEqual(["colors"]);
    await act(() => mockMouse.click(word.x, word.y));
    await settle();
    expect(copies).toEqual(["colors", "14:02 <kai> 0.9.8 adds renderer-wide selection colors"]);
  });

  test("a double-click on a nick copies the nick", async () => {
    const { copies, screen, mockMouse } = await setup();
    const nick = cellOf(screen, "kai", 1);
    await act(() => mockMouse.doubleClick(nick.x, nick.y));
    await settle();
    expect(copies).toEqual(["kai"]);
  });

  test("hidden bidi characters from the server are not copied", async () => {
    const { copies, screen, mockMouse } = await setup();
    const word = cellOf(screen, "photo", 1);
    // A double-click copies the word first, then the third click the message.
    for (let i = 0; i < 3; i++) await act(() => mockMouse.click(word.x, word.y));
    await settle();
    expect(copies).toEqual(["photogpj.exe", "14:05 <eve> photogpj.exe"]);
  });

  test("text selected outside the chat is copied too, in screen order", async () => {
    const { copies, screen, mockMouse } = await setup({ topic: "the honk channel" });
    const from = cellOf(screen, "the honk");
    const to = cellOf(screen, "0.9.8", 4);
    await act(() => mockMouse.drag(from.x, from.y, to.x, to.y));
    await settle();
    expect(copies).toHaveLength(1);
    const lines = copies[0]!.split("\n");
    expect(lines[0]).toStartWith("the honk channel");
    expect(lines.at(-1)).toBe("14:02 <kai> 0.9.8");
  });

  test("the \"new\" divider between messages is not copied", async () => {
    const { copies, screen, mockMouse } = await setup({ firstUnreadId: "c" });
    expect(screen.join("\n")).toContain(" new ");
    const from = cellOf(screen, "café");
    const to = cellOf(screen, "waves", 4);
    await act(() => mockMouse.drag(from.x, from.y, to.x, to.y));
    await settle();
    expect(copies).toEqual(["14:03 <kai> café Привет 🎉 done\n14:04 * fern waves"]);
  });

  test("a plain click copies nothing", async () => {
    const { copies, screen, mockMouse } = await setup();
    const word = cellOf(screen, "waves", 1);
    await act(() => mockMouse.click(word.x, word.y));
    await settle();
    expect(copies).toEqual([]);
  });
});

describe("keys with a selection", () => {
  async function selectWord(h: Harness) {
    const word = cellOf(h.screen, "waves", 1);
    await act(() => h.mockMouse.doubleClick(word.x, word.y));
    await settle();
  }

  test("Ctrl+C copies and clears the selection, and a second Ctrl+C does its normal job", async () => {
    const h = await setup();
    await selectWord(h);
    await act(async () => h.mockInput.pressCtrlC());
    await settle();
    expect(h.copies).toEqual(["waves", "waves"]);
    expect(h.keys).toEqual([]);
    expect(h.renderer.getSelection() === null).toBe(true);
    await act(async () => h.mockInput.pressCtrlC());
    expect(h.keys).toEqual(["ctrl+c"]);
  });

  test("Ctrl+C after a plain click does its normal job", async () => {
    const h = await setup();
    const word = cellOf(h.screen, "waves", 1);
    await act(() => h.mockMouse.click(word.x, word.y));
    await act(async () => h.mockInput.pressCtrlC());
    expect(h.copies).toEqual([]);
    expect(h.keys).toEqual(["ctrl+c"]);
  });

  test("Esc only clears the selection", async () => {
    const h = await setup();
    await selectWord(h);
    await act(async () => h.mockInput.pressEscape());
    // A lone Esc byte may start a longer key, so the parser waits a moment for more.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(h.renderer.getSelection() === null).toBe(true);
    expect(h.keys).toEqual([]);
  });

  test("Shift+arrows still select text in the input, and Backspace deletes it", async () => {
    const h = await setup({ inputFocused: true });
    await act(async () => h.mockInput.typeText("hello world"));
    for (let i = 0; i < 6; i++) await act(async () => h.mockInput.pressArrow("left", { shift: true }));
    await act(async () => h.mockInput.pressBackspace());
    await act(async () => h.mockInput.pressEnter());
    expect(h.sent).toEqual(["hello"]);
  });

  test("any other key clears the selection and then does its normal job", async () => {
    const h = await setup();
    await selectWord(h);
    await act(async () => h.mockInput.pressKey("x"));
    expect(h.renderer.getSelection() === null).toBe(true);
    expect(h.keys).toEqual(["x"]);
  });
});

test("a click on a channel in the sidebar switches to it and selects nothing", async () => {
  const copies: string[] = [];
  const picked: string[] = [];
  const server = serverWith({
    name: "#honk",
    kind: "channel",
    topic: "",
    messages: [],
    users: [],
    unread: 0,
    hasMention: false,
  });
  const copyText = recordingCopy(copies);
  function Screen() {
    const onMouseUp = useSelectionCopy(copyText, () => {});
    return (
      <box width="100%" height="100%" onMouseUp={onMouseUp}>
        <Sidebar
          servers={[server]}
          active={null}
          onSelect={(_, buffer) => picked.push(buffer)}
          onConnectServer={() => {}}
        />
      </box>
    );
  }
  const r = await testRender(<Screen />, { width: 30, height: 12 });
  destroy = () => act(() => r.renderer.destroy());
  await r.renderOnce();
  const row = cellOf(r.captureCharFrame().split("\n"), "#honk", 1);
  await act(() => r.mockMouse.doubleClick(row.x, row.y));
  await settle();
  expect(picked).toContain("#honk");
  expect(r.renderer.getSelection() === null).toBe(true);
  expect(copies).toEqual([]);
});

test("a log line names the sender the way irssi does for each kind of line", () => {
  const base = { id: "x", timestamp: at(5) };
  expect(logLine({ ...base, kind: "message", from: "kai", text: "" }, "hi")).toBe("14:05 <kai> hi");
  expect(logLine({ ...base, kind: "action", from: "kai", text: "" }, "kai waves")).toBe("14:05 * kai waves");
  expect(logLine({ ...base, kind: "notice", from: "ChanServ", text: "" }, "hi")).toBe("14:05 -ChanServ- hi");
  expect(logLine({ ...base, kind: "join", text: "" }, "kai joined #honk")).toBe("14:05 -!- kai joined #honk");
});
