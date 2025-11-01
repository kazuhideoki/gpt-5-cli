import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareImageData } from "./image-attachments.js";
import type { ConfigEnvironment } from "../../types.js";
import type { CliLogger, CliLoggerConfig } from "../../foundation/logger/types.js";

type LoggerMessages = Record<"info" | "warn" | "error" | "debug", string[]>;

function createTestLoggerConfig(overrides: { logLabel?: string; debugEnabled?: boolean } = {}): {
  config: CliLoggerConfig;
  messages: LoggerMessages;
} {
  const messages: LoggerMessages = {
    info: [],
    warn: [],
    error: [],
    debug: [],
  };

  const loggerRecord: Record<string, any> = {
    level: "info",
    transports: [],
    log: () => undefined,
  };

  for (const level of ["info", "warn", "error", "debug"] as const) {
    loggerRecord[level] = (message: unknown, ..._meta: unknown[]) => {
      messages[level].push(String(message ?? ""));
      return loggerRecord;
    };
  }

  return {
    config: {
      logger: loggerRecord as CliLogger,
      logLabel: overrides.logLabel ?? "[test-cli]",
      debugEnabled: overrides.debugEnabled ?? false,
    },
    messages,
  };
}

const SCREENSHOT_NAME = "スクリーンショット 2025-01-01.png";

let originalHome: string | undefined;
let tempHomeDir: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt5-cli-home-"));
  process.env.HOME = tempHomeDir;
  fs.mkdirSync(path.join(tempHomeDir, "Desktop"), { recursive: true });
});

afterEach(() => {
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

    const configEnv = createConfigEnv({ HOME: process.env.HOME });
    const { config: loggerConfig, messages } = createTestLoggerConfig();
    const result = prepareImageData(imagePath, loggerConfig, configEnv);

    expect(result).toBeDefined();
    expect(result?.startsWith("data:image/png;base64,")).toBe(true);
    expect(messages.info.some((line) => line.includes("image_attached"))).toBe(true);
  });

  it("デスクトップ上のスクリーンショット名を解決できる", () => {
    if (!process.env.HOME) {
      throw new Error("HOME must be set for test");
    }
    const screenshotPath = path.join(process.env.HOME, "Desktop", SCREENSHOT_NAME);
    fs.writeFileSync(screenshotPath, Buffer.from("fake-screenshot"));

    const configEnv = createConfigEnv({ HOME: process.env.HOME });
    const { config: loggerConfig } = createTestLoggerConfig();
    const result = prepareImageData(SCREENSHOT_NAME, loggerConfig, configEnv);

    expect(result).toBeDefined();
    expect(result?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("HOME 外の絶対パスは拒否する", () => {
    if (!tempHomeDir) {
      throw new Error("tempHomeDir must be initialized");
    }
    const outsidePath = path.join(tempHomeDir, "..", "outside.png");
    const configEnv = createConfigEnv({ HOME: tempHomeDir });
    const { config: loggerConfig } = createTestLoggerConfig();
    expect(() => prepareImageData(outsidePath, loggerConfig, configEnv)).toThrow(
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
      const { config: loggerConfig } = createTestLoggerConfig();
      const result = prepareImageData(imagePath, loggerConfig, configEnv);
      expect(result).toBeDefined();
      expect(result?.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("画像パス未指定ならログを出力しない", () => {
    if (!process.env.HOME) {
      throw new Error("HOME must be set for test");
    }
    const { config: loggerConfig, messages } = createTestLoggerConfig();
    const configEnv = createConfigEnv({ HOME: process.env.HOME });

    const result = prepareImageData(undefined, loggerConfig, configEnv);

    expect(result).toBeUndefined();
    expect(messages.info).toHaveLength(0);
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
