import { expect, test } from "bun:test";
import type { BufferState, ServerState } from "../types.ts";
import { quickOpenRows } from "./Omnibox.tsx";

function buffer(name: string, users: string[] = [], extra: Partial<BufferState> = {}): BufferState {
  const kind = name === "*status" ? "status" : name.startsWith("#") ? "channel" : "dm";
  return {
    name,
    kind,
    topic: "",
    messages: [],
    users: users.map((nick) => ({ prefix: "", nick })),
    unread: 0,
    hasMention: false,
    ...extra,
  };
}

function server(id: string, buffers: BufferState[]): ServerState {
  return {
    id,
    name: id,
    config: { id, host: "127.0.0.1", nick: "goose" },
    status: "connected",
    nick: "goose",
    casemapping: "rfc1459",
    tls: false,
    buffers: Object.fromEntries(buffers.map((b) => [b.name, b])),
    bufferOrder: buffers.map((b) => b.name),
  };
}

const noop = () => {};
const rows = (q: string, servers: ServerState[]) =>
  quickOpenRows(q, {
    servers,
    active: { serverId: "alpha", buffer: "#honk" },
    recentKeys: [],
    onSelectBuffer: noop,
    onOpenDm: noop,
  }).map((item) => `${item.label} ${item.detail}`);

const alpha = server("alpha", [
  buffer("*status"),
  buffer("#honk", ["goose", "alice", "bob"]),
  buffer("#rust", ["goose", "carol"]),
]);
const beta = server("beta", [buffer("*status"), buffer("#birds", ["goose", "alice"])]);

test("a person whose nick matches ranks above buffers that match by their server's name", () => {
  expect(rows("al", [alpha, beta]).slice(0, 2)).toEqual(["@alice user, alpha", "@alice user, beta"]);
  expect(rows("al", [alpha, beta])).toContain("#honk alpha");
});

test("many buffers on a matching server can't push a person out of the first rows", () => {
  const big = server("alpha", [
    buffer("#honk", ["goose", "alice"]),
    ...Array.from({ length: 12 }, (_, i) => buffer(`#chan${i}`)),
  ]);
  expect(rows("al", [big])[0]).toBe("@alice user, alpha");
});

test("people match fuzzily, like buffers", () => {
  expect(rows("alc", [alpha])[0]).toBe("@alice user, alpha");
});

test("the server name picks the server", () => {
  expect(rows("alice beta", [alpha, beta])).toEqual(["@alice user, beta"]);
});

test("someone with a DM shows once, as the DM buffer", () => {
  const withDm = server("alpha", [buffer("#honk", ["goose", "alice"]), buffer("alice")]);
  expect(rows("alice", [withDm])).toEqual(["@alice alpha"]);
});

test("on an equal match, a buffer comes before a person", () => {
  // "#al" and "@al": the same match on a two-letter name after one symbol.
  const s = server("zeta", [buffer("#al", ["goose", "al"])]);
  expect(rows("al", [s])).toEqual(["#al zeta", "@al user, zeta"]);
});

test("# lists channels only, with no people", () => {
  expect(rows("#", [alpha, beta]).every((r) => r.startsWith("#"))).toBe(true);
  expect(rows("#al", [alpha]).some((r) => r.includes("user,"))).toBe(false);
});

test("with nothing typed, only buffers show, the one you are in last", () => {
  const list = rows("", [alpha]);
  expect(list.every((r) => !r.includes("user,"))).toBe(true);
  expect(list.at(-1)).toBe("#honk alpha");
});

test("you are never offered as a person", () => {
  expect(rows("goose", [alpha])).toEqual([]);
});
