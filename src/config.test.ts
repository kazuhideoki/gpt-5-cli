import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROOT_DIR,
  ensureApiKey,
  loadDefaults,
  readSystemPrompt,
  resolveHistoryPath,
} from "./config.js";

const envKeys = [
  "OPENAI_HISTORY_INDEX_FILE",
  "HOME",
  "OPENAI_MODEL_MAIN",
  "OPENAI_MODEL_MINI",
  "OPENAI_MODEL_NANO",
  "OPENAI_DEFAULT_EFFORT",
  "OPENAI_DEFAULT_VERBOSITY",
  "OPENAI_API_KEY",
];

const envBackup = new Map<string, string | undefined>();
let tempDir: string | null = null;

beforeEach(() => {
  envKeys.forEach((key) => {
    envBackup.set(key, process.env[key]);
    delete process.env[key];
  });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-config-test-"));
  process.env.HOME = tempDir;
});

afterEach(() => {
  envKeys.forEach((key) => {
    const original = envBackup.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  });
  envBackup.clear();
});

afterAll(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("resolveHistoryPath", () => {
  it("環境変数が設定されていれば展開して返す", () => {
    process.env.OPENAI_HISTORY_INDEX_FILE = "~/history/log.json";
    const resolved = resolveHistoryPath("/default.json");
    expect(resolved).toBe(path.resolve(path.join(process.env.HOME!, "history/log.json")));
  });

  it("環境変数が未設定なら既定値を返す", () => {
    const resolved = resolveHistoryPath("/default.json");
    expect(resolved).toBe(path.resolve("/default.json"));
  });

  it("空文字列を設定するとエラーになる", () => {
    process.env.OPENAI_HISTORY_INDEX_FILE = "   ";
    expect(() => resolveHistoryPath("/default.json")).toThrow("OPENAI_HISTORY_INDEX_FILE is set but empty.");
  });

  it("HOME が無い状態で ~ を使うとエラーになる", () => {
    delete process.env.HOME;
    process.env.OPENAI_HISTORY_INDEX_FILE = "~/history.json";
    expect(() => resolveHistoryPath("/default.json")).toThrow("HOME environment variable is required when using '~' paths.");
  });
});

describe("loadDefaults", () => {
  it("既定値を返す", () => {
    const defaults = loadDefaults();
    expect(defaults.modelMain).toBe("gpt-5");
    expect(defaults.modelMini).toBe("gpt-5-mini");
    expect(defaults.modelNano).toBe("gpt-5-nano");
    expect(defaults.effort).toBe("low");
    expect(defaults.verbosity).toBe("low");
    expect(defaults.historyIndexPath).toBe(path.join(ROOT_DIR, "history_index.json"));
    expect(defaults.systemPromptPath).toBe(path.join(ROOT_DIR, "system_prompt.txt"));
  });

  it("環境変数を反映する", () => {
    process.env.OPENAI_MODEL_MAIN = "main-x";
    process.env.OPENAI_MODEL_MINI = "mini-x";
    process.env.OPENAI_MODEL_NANO = "nano-x";
    process.env.OPENAI_DEFAULT_EFFORT = "high";
    process.env.OPENAI_DEFAULT_VERBOSITY = "medium";
    process.env.OPENAI_HISTORY_INDEX_FILE = "~/data/hist.json";
    const defaults = loadDefaults();
    expect(defaults.modelMain).toBe("main-x");
    expect(defaults.modelMini).toBe("mini-x");
    expect(defaults.modelNano).toBe("nano-x");
    expect(defaults.effort).toBe("high");
    expect(defaults.verbosity).toBe("medium");
    expect(defaults.historyIndexPath).toBe(path.resolve(path.join(process.env.HOME!, "data/hist.json")));
  });

  it("不正なレベルはエラーになる", () => {
    process.env.OPENAI_DEFAULT_EFFORT = "invalid";
    process.env.OPENAI_DEFAULT_VERBOSITY = "other";
    expect(() => loadDefaults()).toThrow('OPENAI_DEFAULT_EFFORT must be one of "low", "medium", or "high". Received: invalid');
  });
});

describe("ensureApiKey", () => {
  it("API キーが無い場合は例外を投げる", () => {
    expect(() => ensureApiKey()).toThrow("OPENAI_API_KEY not found");
  });

  it("API キーがあれば返す", () => {
    process.env.OPENAI_API_KEY = "test-key";
    expect(ensureApiKey()).toBe("test-key");
  });
});

describe("readSystemPrompt", () => {
  it("存在しない場合は undefined", () => {
    const filePath = path.join(tempDir ?? ".", "missing.txt");
    expect(readSystemPrompt(filePath)).toBeUndefined();
  });

  it("空ファイルなら undefined", () => {
    const filePath = path.join(tempDir ?? ".", "empty.txt");
    fs.writeFileSync(filePath, "   \n", "utf8");
    expect(readSystemPrompt(filePath)).toBeUndefined();
  });

  it("内容があればそのまま返す", () => {
    const filePath = path.join(tempDir ?? ".", "prompt.txt");
    fs.writeFileSync(filePath, "こんにちは\n", "utf8");
    expect(readSystemPrompt(filePath)).toBe("こんにちは\n");
  });
});
