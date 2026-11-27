import { expect, test } from "bun:test";
import type { ChatMessage } from "../types.ts";
import { getCompletions } from "./completion.ts";

const from = (nick: string) => ({ from: nick }) as ChatMessage;

test("offers a nick once when the server's casemapping folds two spellings together", () => {
  const ctx = {
    users: [{ prefix: "", nick: "Alice^" }],
    messages: [from("alice~")],
    channels: [],
    myNick: "goose",
  };
  expect(getCompletions("al", { ...ctx, casemapping: "rfc1459" })).toEqual(["Alice^: "]);
  expect(getCompletions("al", { ...ctx, casemapping: "ascii" })).toEqual([
    "alice~: ",
    "Alice^: ",
  ]);
});

test("leaves out your own nick as the server folds it", () => {
  const ctx = { users: [{ prefix: "", nick: "Goose^" }], messages: [], channels: [] };
  expect(getCompletions("go", { ...ctx, myNick: "goose~", casemapping: "rfc1459" })).toEqual([]);
});
