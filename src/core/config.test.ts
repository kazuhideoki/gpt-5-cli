import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT_DIR, loadDefaults, resolveHistoryPath, resolvePromptsDir } from "./config.js";

const envKeys = [
  "GPT_5_CLI_HISTORY_INDEX_FILE",
  "GPT_5_CLI_PROMPTS_DIR",
  "HOME",
  "OPENAI_MODEL_MAIN",
  "OPENAI_MODEL_MINI",
  "OPENAI_MODEL_NANO",
  "OPENAI_DEFAULT_EFFORT",
  "OPENAI_DEFAULT_VERBOSITY",
  "OPENAI_API_KEY",
  "GPT_5_CLI_D2_MAX_ITERATIONS",
  "GPT_5_CLI_SQL_MAX_ITERATIONS",
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
    process.env.GPT_5_CLI_HISTORY_INDEX_FILE = "~/history/log.json";
    const resolved = resolveHistoryPath("/default.json");
    expect(resolved).toBe(path.resolve(path.join(process.env.HOME!, "history/log.json")));
  });

  it("環境変数が未設定なら既定値を返す", () => {
    const resolved = resolveHistoryPath("/default.json");
    expect(resolved).toBe(path.resolve("/default.json"));
  });

  it("空文字列を設定するとエラーになる", () => {
    process.env.GPT_5_CLI_HISTORY_INDEX_FILE = "   ";
    expect(() => resolveHistoryPath("/default.json")).toThrow(
      "GPT_5_CLI_HISTORY_INDEX_FILE is set but empty.",
    );
  });

  it("HOME が無い状態で ~ を使うとエラーになる", () => {
    delete process.env.HOME;
    process.env.GPT_5_CLI_HISTORY_INDEX_FILE = "~/history.json";
    expect(() => resolveHistoryPath("/default.json")).toThrow(
      "HOME environment variable is required when using '~' paths.",
    );
  });
});

describe("resolvePromptsDir", () => {
  it("環境変数が設定されていれば展開して返す", () => {
    process.env.GPT_5_CLI_PROMPTS_DIR = "~/prompts/custom";
    const resolved = resolvePromptsDir("/default/prompts");
    expect(resolved).toBe(path.resolve(path.join(process.env.HOME!, "prompts/custom")));
  });

  it("環境変数が未設定なら既定値を返す", () => {
    const resolved = resolvePromptsDir("/default/prompts");
    expect(resolved).toBe(path.resolve("/default/prompts"));
  });

  it("空文字列を設定するとエラーになる", () => {
    process.env.GPT_5_CLI_PROMPTS_DIR = "   ";
    expect(() => resolvePromptsDir("/default/prompts")).toThrow(
      "GPT_5_CLI_PROMPTS_DIR is set but empty.",
    );
  });

  it("HOME が無い状態で ~ を使うとエラーになる", () => {
    delete process.env.HOME;
    process.env.GPT_5_CLI_PROMPTS_DIR = "~/prompts";
    expect(() => resolvePromptsDir("/default/prompts")).toThrow(
      "HOME environment variable is required when using '~' paths.",
    );
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
    expect(defaults.promptsDir).toBe(path.join(ROOT_DIR, "prompts"));
    expect(defaults.d2MaxIterations).toBe(8);
    expect(defaults.sqlMaxIterations).toBe(8);
  });

  it("環境変数を反映する", () => {
    process.env.OPENAI_MODEL_MAIN = "main-x";
    process.env.OPENAI_MODEL_MINI = "mini-x";
    process.env.OPENAI_MODEL_NANO = "nano-x";
    process.env.OPENAI_DEFAULT_EFFORT = "high";
    process.env.OPENAI_DEFAULT_VERBOSITY = "medium";
    process.env.GPT_5_CLI_HISTORY_INDEX_FILE = "~/data/hist.json";
    process.env.GPT_5_CLI_PROMPTS_DIR = "~/data/prompts";
    process.env.GPT_5_CLI_D2_MAX_ITERATIONS = "5";
    process.env.GPT_5_CLI_SQL_MAX_ITERATIONS = "9";
    const defaults = loadDefaults();
    expect(defaults.modelMain).toBe("main-x");
    expect(defaults.modelMini).toBe("mini-x");
    expect(defaults.modelNano).toBe("nano-x");
    expect(defaults.effort).toBe("high");
    expect(defaults.verbosity).toBe("medium");
    expect(defaults.historyIndexPath).toBe(
      path.resolve(path.join(process.env.HOME!, "data/hist.json")),
    );
    expect(defaults.promptsDir).toBe(path.resolve(path.join(process.env.HOME!, "data/prompts")));
    expect(defaults.d2MaxIterations).toBe(5);
    expect(defaults.sqlMaxIterations).toBe(9);
  });

  it("不正なレベルはエラーになる", () => {
    process.env.OPENAI_DEFAULT_EFFORT = "invalid";
    process.env.OPENAI_DEFAULT_VERBOSITY = "other";
    expect(() => loadDefaults()).toThrow(
      'OPENAI_DEFAULT_EFFORT must be one of "low", "medium", or "high". Received: invalid',
    );
  });
});
