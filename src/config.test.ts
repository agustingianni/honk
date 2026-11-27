import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, saveThemeSetting, setThemeInConfigText } from "./config.ts";

describe("setThemeInConfigText", () => {
  test("replaces an existing theme and keeps the rest of the text", () => {
    const text = `{
  "theme": "nord",
  "servers": [ { "host": "irc.libera.chat" } ]
}
`;
    expect(setThemeInConfigText(text, "dracula")).toBe(`{
  "theme": "dracula",
  "servers": [ { "host": "irc.libera.chat" } ]
}
`);
  });

  test("adds the theme as the first key, with the file's indent", () => {
    const text = `{
    "notifications": false,
    "servers": []
}
`;
    expect(setThemeInConfigText(text, "nord")).toBe(`{
    "theme": "nord",
    "notifications": false,
    "servers": []
}
`);
  });

  test("fills an empty object", () => {
    expect(setThemeInConfigText("{}\n", "nord")).toBe('{ "theme": "nord" }\n');
    expect(setThemeInConfigText("{ }", "nord")).toBe('{ "theme": "nord" }');
  });

  test("adds a top-level theme when only a nested one exists", () => {
    const text = '{ "servers": [ { "theme": "x" } ] }';
    expect(setThemeInConfigText(text, "nord")).toBe(
      '{\n  "theme": "nord", "servers": [ { "theme": "x" } ] }',
    );
  });

  test("refuses text that is not a JSON object", () => {
    expect(() => setThemeInConfigText("[]", "nord")).toThrow();
    expect(() => setThemeInConfigText('{ "servers": [ }', "nord")).toThrow();
  });
});

describe("saveThemeSetting", () => {
  test("creates a missing file and its folder, and loadConfig reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
    try {
      const path = join(dir, "honk", "config.json");
      saveThemeSetting(path, "nord");
      expect(readFileSync(path, "utf-8")).toBe('{\n  "theme": "nord"\n}\n');
      const config = loadConfig(["--config", path]);
      expect(config.theme).toBe("nord");
      expect(config.path).toBe(path);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("updates an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, '{ "theme": "nord", "servers": [] }\n');
      saveThemeSetting(path, "dracula");
      expect(readFileSync(path, "utf-8")).toBe('{ "theme": "dracula", "servers": [] }\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("writes through a symlink and keeps the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
    try {
      const real = join(dir, "dotfiles-config.json");
      const link = join(dir, "config.json");
      writeFileSync(real, '{ "servers": [] }\n');
      symlinkSync(real, link);
      saveThemeSetting(link, "nord");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf-8")).toBe('{\n  "theme": "nord", "servers": [] }\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("a --config file that does not exist yet is where the theme goes", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
    try {
      const path = join(dir, "mine.json");
      const config = loadConfig(["--config", path]);
      expect(config.path).toBe(path);
      saveThemeSetting(config.path!, "nord");
      expect(loadConfig(["--config", path]).theme).toBe("nord");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

/**
 * Runs loadConfig with --config pointing at honk.json in a new temp directory,
 * holding `text`, or missing when `text` is null. More flags go after --config.
 */
function load(text: string | null, ...flags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
  try {
    const path = join(dir, "honk.json");
    if (text !== null) writeFileSync(path, text);
    return loadConfig(["--config", path, ...flags]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs load on a config file holding `text`, and returns what it throws. */
function loadError(text: string): unknown {
  try {
    load(text);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("loadConfig with a broken file", () => {
  test("broken JSON is a ConfigError that names the file, not a stack trace", () => {
    const err = loadError('{"servers": [ {"host": "x",, } ]}');
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/honk\.json is not valid JSON: \S/);
  });

  test("JSON that is not an object is a ConfigError", () => {
    const err = loadError("[1, 2]");
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toEndWith('must hold a JSON object, such as {"servers": [...]}');
  });
});

describe("the mouse setting", () => {
  test("is on when the key is missing, and with no config file", () => {
    expect(load('{ "servers": [] }').mouse).toBe(true);
    expect(load("{}").mouse).toBe(true);
    // JSON null counts as missing, as it does for "notifications".
    expect(load('{ "mouse": null }').mouse).toBe(true);
    expect(load(null).mouse).toBe(true);
  });

  test("follows true and false in the file", () => {
    expect(load('{ "mouse": true, "servers": [] }').mouse).toBe(true);
    expect(load('{ "mouse": false, "servers": [] }').mouse).toBe(false);
    expect(load('{ "mouse": false }').mouse).toBe(false);
  });

  test("--no-mouse turns it off for one run", () => {
    expect(load('{ "servers": [] }', "--no-mouse").mouse).toBe(false);
    expect(load(null, "--no-mouse").mouse).toBe(false);
  });

  test("a value that is not a boolean is a ConfigError", () => {
    for (const value of ['"false"', "0", "[]"]) {
      const err = loadError(`{ "mouse": ${value}, "servers": [] }`);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toEndWith(`honk.json: "mouse" must be true or false, not ${value}`);
    }
  });
});

describe("the ascii setting", () => {
  test("comes from the file, and --ascii or --no-ascii wins for one run", () => {
    expect(load('{ "ascii": true, "servers": [] }').ascii).toBe(true);
    expect(load('{ "ascii": true, "servers": [] }', "--no-ascii").ascii).toBe(false);
    expect(load('{ "servers": [] }').ascii).toBeUndefined();
    expect(load('{ "ascii": null }').ascii).toBeUndefined();
    expect(load('{ "servers": [] }', "--ascii").ascii).toBe(true);
    expect(load(null, "--ascii").ascii).toBe(true);
  });

  test("a value that is not a boolean is a ConfigError", () => {
    for (const value of ['"true"', "1"]) {
      const err = loadError(`{ "ascii": ${value}, "servers": [] }`);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toEndWith(`honk.json: "ascii" must be true or false, not ${value}`);
    }
  });
});
