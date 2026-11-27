import { afterEach, expect, test } from "bun:test";
import { until } from "../../dev/fakeircd/testing.ts";
import { cellWidth } from "../ui/display.ts";
import { DEMO_NETWORKS } from "./demo.ts";
import { IrcManager } from "./manager.ts";

let m: IrcManager | undefined;
afterEach(() => m?.disconnectAll());

test("/whois in the demo is worded as a real WHOIS reply", async () => {
  m = new IrcManager();
  m.startDemo();
  m.setActive("demo-libera", "#honk");
  m.handleInput("/whois alice");
  const lines = () =>
    m!
      .getSnapshot()
      .servers.find((s) => s.id === "demo-libera")
      ?.buffers["#honk"]?.messages.map((x) => x.text)
      .filter((t) => t.startsWith("alice ")) ?? [];
  await until(() => lines().length > 0);
  expect(lines()).toEqual([
    "alice is ~alice@user/alice",
    "alice is in @#honk",
    "alice is on libera.chat",
    "alice has been idle 2 minutes",
  ]);
});

test("the demo has wide characters to show how honk measures them", () => {
  const birds = DEMO_NETWORKS.find((n) => n.id === "demo-libera")?.buffers.find((b) => b.name === "#birds");
  // Wider in cells than in code units: CJK. Narrower: a ZWJ emoji or a flag.
  const wide = (text: string) => cellWidth(text) > text.length;
  const emoji = (text: string) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
  expect(birds?.topic).toSatisfy((t) => !!t && wide(t) && emoji(t));
  expect(birds?.lines.some((l) => wide(l.text))).toBe(true);
  expect(birds?.lines.some((l) => l.text.includes("\u200d"))).toBe(true);
});
