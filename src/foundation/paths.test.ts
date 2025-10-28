/**
 * paths.ts の環境変数依存挙動を TDD で定義するテストスケルトン。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { expandHome } from "./paths.js";
import type { ConfigEnvironment } from "../types.js";

function createConfigEnv(values: Record<string, string | undefined>): ConfigEnvironment {
  return {
    get: (key: string) => values[key],
    has: (key: string) => values[key] !== undefined,
    entries(): IterableIterator<readonly [key: string, value: string]> {
      const entries = Object.entries(values).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      return entries[Symbol.iterator]();
    },
  };
}

let originalHome: string | undefined;
let cleanupDirs: string[];
let cleanupTasks: Array<() => void | Promise<void>>;

beforeEach(() => {
  originalHome = process.env.HOME;
  cleanupDirs = [];
  cleanupTasks = [];
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  for (const dir of cleanupDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) {
      task();
    }
  }
});

describe("expandHome", () => {
  it("ConfigEnv の HOME を優先して展開する", () => {
    const processHome = path.join(path.sep, "env-home");
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "config-home-"));
    cleanupDirs.push(configHome);
    process.env.HOME = processHome;
    const env = createConfigEnv({ HOME: configHome });
    const result = expandHome("~/documents/file.txt", env);
    expect(result).toBe(path.join(configHome, "documents", "file.txt"));
  });

  it("ConfigEnv に HOME が無い場合は OS のホームディレクトリを利用する", () => {
    const fallbackHome = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-home-"));
    cleanupDirs.push(fallbackHome);
    const originalHomedir = os.homedir;
    registerCleanup(() => {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    });
    (os as unknown as { homedir: () => string }).homedir = () => fallbackHome;
    process.env.HOME = path.join(path.sep, "process-home");

    const env = createConfigEnv({});
    const result = expandHome("~/data.txt", env);
    expect(result).toBe(path.join(fallbackHome, "data.txt"));
  });
});
function registerCleanup(task: () => void | Promise<void>): void {
  cleanupTasks.push(task);
}
