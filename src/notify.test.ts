import { describe, expect, test } from "bun:test";
import {
  formatMissedSummary,
  formatNotification,
  MAX_BODY_LENGTH,
  type MentionEvent,
  NOTIFY_COOLDOWN_MS,
  Notifier,
  stripIrcFormatting,
} from "./notify.ts";
import { fakeClock } from "./fakeClock.ts";

function event(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    serverId: "libera",
    bufferName: "#honk",
    bufferKind: "channel",
    kind: "message",
    from: "alice",
    text: "goose: ping",
    isActiveBuffer: false,
    ...overrides,
  };
}

/** A Notifier with a fake clock that records what it sends. */
function setup(sendResult = true) {
  const sent: { message: string; title: string }[] = [];
  const clock = fakeClock(1_000_000);
  const notifier = new Notifier(
    (message, title) => {
      sent.push({ message, title });
      return sendResult;
    },
    clock,
  );
  return { notifier, sent, advance: clock.advance };
}

describe("stripIrcFormatting", () => {
  test.each([
    ["\x02bold\x02 text", "bold text"],
    ["\x0304,01red\x03 plain", "red plain"],
    ["\x0312blue", "blue"],
    ["\x04ff0000hex\x0f", "hex"],
    ["\x1ditalic\x1d \x1funder\x1f", "italic under"],
    ["tab\tstays", "tab\tstays"],
    ["no codes", "no codes"],
  ])("%j", (input, expected) => {
    expect(stripIrcFormatting(input)).toBe(expected);
  });
});

describe("bidi controls", () => {
  // The system shows notifications with bidi: U+202E would turn "gpj.exe" into
  // "exe.jpg", and U+2066..U+2069 would move text around.
  const bad = event({
    from: "al\u202Eice",
    bufferName: "#ho\u2066nk\u2069",
    text: "goose: see photo\u202Egpj.exe\u200F\u009c",
  });

  test("are removed from the nick, the channel and the text", () => {
    const { notifier, sent } = setup();
    notifier.notify(bad);
    expect(sent).toEqual([{ title: "alice in #honk", message: "goose: see photogpj.exe" }]);
  });

  test("are removed from the missed-mentions summary", () => {
    const { notifier, sent } = setup();
    notifier.notifyMissed([bad, { ...bad, bufferName: "#b\u202Eird" }]);
    expect(sent[0]!.message).toBe("2 mentions while you were away, in #honk and #bird");
  });

  test("leave right-to-left text alone", () => {
    const { notifier, sent } = setup();
    const text = "goose: \u05E9\u05DC\u05D5\u05DD \u0645\u0631\u062D\u0628\u0627";
    notifier.notify(event({ text }));
    expect(sent[0]!.message).toBe(text);
  });
});

describe("formatNotification", () => {
  test("a channel mention names the sender and the channel", () => {
    expect(formatNotification(event())).toEqual({
      title: "alice in #honk",
      body: "goose: ping",
    });
  });

  test("a DM names only the sender", () => {
    expect(formatNotification(event({ bufferKind: "dm", bufferName: "alice" }))).toEqual({
      title: "alice",
      body: "goose: ping",
    });
  });

  test("an action reads like it does in the chat", () => {
    expect(formatNotification(event({ kind: "action", text: "waves at goose" })).body).toBe(
      "* alice waves at goose",
    );
  });

  test("a long message is cut", () => {
    const body = formatNotification(event({ text: "x".repeat(500) })).body;
    expect(body.length).toBe(MAX_BODY_LENGTH);
    expect(body.endsWith("...")).toBe(true);
  });
});

describe("Notifier", () => {
  test("notifies for a buffer that is not on screen", () => {
    const { notifier, sent } = setup();
    expect(notifier.notify(event())).toBe(true);
    expect(sent).toEqual([{ message: "goose: ping", title: "alice in #honk" }]);
  });

  test("stays quiet for the buffer on screen while the terminal has focus", () => {
    const { notifier, sent } = setup();
    expect(notifier.notify(event({ isActiveBuffer: true }))).toBe(false);
    expect(sent).toEqual([]);
  });

  test("notifies for the buffer on screen when the terminal lost focus", () => {
    const { notifier, sent } = setup();
    notifier.setFocused(false);
    expect(notifier.notify(event({ isActiveBuffer: true }))).toBe(true);
    expect(sent.length).toBe(1);
  });

  test("sends at most one notification per buffer in the cooldown", () => {
    const { notifier, sent, advance } = setup();
    notifier.notify(event());
    advance(NOTIFY_COOLDOWN_MS - 1);
    expect(notifier.notify(event())).toBe(false);
    // Another buffer has its own cooldown.
    expect(notifier.notify(event({ bufferName: "#other" }))).toBe(true);
    advance(1);
    expect(notifier.notify(event())).toBe(true);
    expect(sent.map((s) => s.title)).toEqual([
      "alice in #honk",
      "alice in #other",
      "alice in #honk",
    ]);
  });

  test("a failed send does not start the cooldown", () => {
    const { notifier, sent } = setup(false);
    expect(notifier.notify(event())).toBe(false);
    expect(notifier.notify(event())).toBe(false);
    expect(sent.length).toBe(2);
  });
});

describe("missed mentions", () => {
  test("one missed mention gets the usual notification", () => {
    const { notifier, sent } = setup();
    expect(notifier.notifyMissed([event()])).toBe(true);
    expect(sent).toEqual([{ message: "goose: ping", title: "alice in #honk" }]);
  });

  test("several get one summary", () => {
    const { notifier, sent } = setup();
    notifier.notifyMissed([
      event(),
      event({ from: "bob" }),
      event({ bufferKind: "dm", bufferName: "carol", from: "carol" }),
    ]);
    expect(sent).toEqual([
      { message: "3 mentions while you were away, in #honk and carol", title: "Missed mentions" },
    ]);
  });

  test("skips the buffer on screen while the terminal has focus", () => {
    const { notifier, sent } = setup();
    expect(notifier.notifyMissed([event({ isActiveBuffer: true })])).toBe(false);
    notifier.notifyMissed([event({ isActiveBuffer: true }), event({ bufferName: "#other" })]);
    expect(sent.map((s) => s.title)).toEqual(["alice in #other"]);
  });

  test("the summary names three or more places", () => {
    const body = formatMissedSummary([
      event({ bufferName: "#a" }),
      event({ bufferName: "#b" }),
      event({ bufferName: "#c" }),
    ]);
    expect(body).toBe("3 mentions while you were away, in #a, #b and #c");
  });
});
