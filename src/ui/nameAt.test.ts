import { expect, test } from "bun:test";
import { nameAt } from "./nameAt.ts";

const findNick = (word: string) => ["bob", "x[m]"].find((nick) => nick === word.toLowerCase());

/** The name at the first "^" under `text` in `marks`. */
function at(text: string, marks: string) {
  const name = nameAt(text, marks.indexOf("^"), findNick);
  return name && `${name.kind} ${text.slice(name.start, name.end)} -> ${name.name}`;
}

test("a nick of someone in the channel is a name, with the punctuation around it left out", () => {
  expect(at("bob: hi", "^")).toBe("nick bob -> bob");
  expect(at("hi @Bob!", "     ^")).toBe("nick Bob -> bob");
  expect(at("ask x[m] now", "      ^")).toBe("nick x[m] -> x[m]");
  expect(at("ping [bob]", "      ^")).toBe("nick bob -> bob");
  expect(at("ping {BOB}.", "      ^")).toBe("nick BOB -> bob");
});

test("other words are not names", () => {
  expect(at("hello bob", "^")).toBeUndefined();
  expect(at("bobby", "^")).toBeUndefined();
  expect(at("bob: hi", "   ^")).toBeUndefined(); // the colon
  expect(at("bob: hi", "    ^")).toBeUndefined(); // the space
  expect(at("ping [bob]", "     ^")).toBeUndefined(); // the bracket
});

test("a word that starts with # is a channel name", () => {
  expect(at("join #rust", "      ^")).toBe("channel #rust -> #rust");
  expect(at("join ##linux.", "     ^")).toBe("channel ##linux -> ##linux");
  expect(at("(see #c++, #go)", "     ^")).toBe("channel #c++ -> #c++");
  expect(at("(see #c++, #go)", "            ^")).toBe("channel #go -> #go");
  expect(at("#rust's topic", " ^")).toBe("channel #rust -> #rust");
});

test("punctuation around a channel name and a number after # are not names", () => {
  expect(at("(see #go)", "^")).toBeUndefined();
  expect(at("(see #go)", "        ^")).toBeUndefined();
  expect(at("fixed in #24", "          ^")).toBeUndefined();
  expect(at("just # here", "     ^")).toBeUndefined();
});

test("a nick after # is part of the channel name", () => {
  expect(at("#bob", " ^")).toBe("channel #bob -> #bob");
});
