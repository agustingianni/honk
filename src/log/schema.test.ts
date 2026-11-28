import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  checkSqlite,
  NewerSchemaError,
  prepare,
  SCHEMA_VERSION,
  sqlList,
  userVersion,
} from "./schema.ts";

test("this SQLite can hold the Log", () => {
  expect(checkSqlite(new Database(":memory:"))).toBeUndefined();
});

test("prepare brings a new file to the current schema, with incremental vacuum", () => {
  const db = new Database(":memory:");
  prepare(db);
  expect(userVersion(db)).toBe(SCHEMA_VERSION);
  expect(db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
  expect(db.query("PRAGMA journal_size_limit").get()).toEqual({ journal_size_limit: 16777216 });
  // A second prepare changes nothing.
  prepare(db);
  expect(userVersion(db)).toBe(SCHEMA_VERSION);
});

test("prepare refuses a file from a newer honk", () => {
  const db = new Database(":memory:");
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  expect(() => prepare(db)).toThrow(NewerSchemaError);
});

test("sqlList quotes each kind", () => {
  expect(sqlList(["join", "part"])).toBe("'join', 'part'");
});
