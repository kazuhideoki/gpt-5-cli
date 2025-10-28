import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareImageData } from "./image-attachments.js";
import type { ConfigEnvironment } from "../../types.js";

const SCREENSHOT_NAME = "スクリーンショット 2025-01-01.png";

let originalHome: string | undefined;
let tempHomeDir: string | undefined;
let originalConsoleLog: typeof console.log;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt5-cli-home-"));
  process.env.HOME = tempHomeDir;
  fs.mkdirSync(path.join(tempHomeDir, "Desktop"), { recursive: true });
  originalConsoleLog = console.log;
});

afterEach(() => {
  console.log = originalConsoleLog;
  if (tempHomeDir && fs.existsSync(tempHomeDir)) {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  }
  process.env.HOME = originalHome;
});

describe("prepareImageData", () => {
  it("HOME 配下の絶対パスを data URL に変換する", () => {
    if (!process.env.HOME) {
      throw new Error("HOME must be set for test");
    }
    const imagePath = path.join(process.env.HOME, "sample.png");
    fs.writeFileSync(imagePath, Buffer.from("fake-png-data"));

    const logs: string[] = [];
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };

    const configEnv = createConfigEnv({ HOME: process.env.HOME });
    const result = prepareImageData(imagePath, "[test-cli]", configEnv);

    expect(result).toBeDefined();
    expect(result?.startsWith("data:image/png;base64,")).toBe(true);
    expect(logs.some((line) => line.includes("image_attached"))).toBe(true);
  });

  it("デスクトップ上のスクリーンショット名を解決できる", () => {
    if (!process.env.HOME) {
      throw new Error("HOME must be set for test");
    }
    const screenshotPath = path.join(process.env.HOME, "Desktop", SCREENSHOT_NAME);
    fs.writeFileSync(screenshotPath, Buffer.from("fake-screenshot"));

    const configEnv = createConfigEnv({ HOME: process.env.HOME });
    const result = prepareImageData(SCREENSHOT_NAME, "[test-cli]", configEnv);

    expect(result).toBeDefined();
    expect(result?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("HOME 外の絶対パスは拒否する", () => {
    if (!tempHomeDir) {
      throw new Error("tempHomeDir must be initialized");
    }
    const outsidePath = path.join(tempHomeDir, "..", "outside.png");
    const configEnv = createConfigEnv({ HOME: tempHomeDir });
    expect(() => prepareImageData(outsidePath, "[test-cli]", configEnv)).toThrow(
      "Error: -i で指定できるフルパスは",
    );
  });

  it("ConfigEnv の HOME を使用できる", () => {
    if (!tempHomeDir) {
      throw new Error("tempHomeDir must be initialized");
    }
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "config-home-"));
    const configEnv = createConfigEnv({ HOME: configHome });
    const imagePath = path.join(configHome, "sample.png");
    fs.writeFileSync(imagePath, Buffer.from("fake-png-data"));

    process.env.HOME = tempHomeDir;

    try {
      const result = prepareImageData(imagePath, "[test-cli]", configEnv);
      expect(result).toBeDefined();
      expect(result?.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });
});

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
