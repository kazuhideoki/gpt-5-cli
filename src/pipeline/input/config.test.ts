import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT_DIR } from "../../foundation/paths.js";
import {
  DEFAULT_MAX_ITERATIONS,
  loadDefaults,
  loadEnvironment,
  resolvePromptsDir,
} from "./config.js";

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
  "GPT_5_CLI_MAX_ITERATIONS",
];

const envBackup = new Map<string, string | undefined>();
let tempDir: string | null = null;

beforeEach(() => {
  for (const key of envKeys) {
    envBackup.set(key, process.env[key]);
    delete process.env[key];
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-config-test-"));
  process.env.HOME = tempDir;
});

afterEach(() => {
  for (const key of envKeys) {
    const original = envBackup.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  envBackup.clear();
});

afterAll(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("loadEnvironment", () => {
  const targetEnv = "OPENAI_DEFAULT_EFFORT";

  afterEach(() => {
    delete process.env[targetEnv];
  });

  it(".env が存在しなくても読み込みを継続する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-load-env-"));
    try {
      expect(() => loadEnvironment({ baseDir: dir, envSuffix: "ask" })).not.toThrow();
      expect(process.env.OPENAI_DEFAULT_EFFORT).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(".env の値が設定される", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-load-env-"));
    try {
      fs.writeFileSync(path.join(dir, ".env"), "OPENAI_DEFAULT_EFFORT=medium\n", "utf8");
      loadEnvironment({ baseDir: dir });
      expect(process.env.OPENAI_DEFAULT_EFFORT).toBe("medium");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(".env.{suffix} が .env を上書きする", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-load-env-"));
    try {
      fs.writeFileSync(path.join(dir, ".env"), "OPENAI_DEFAULT_EFFORT=medium\n", "utf8");
      fs.writeFileSync(path.join(dir, ".env.ask"), "OPENAI_DEFAULT_EFFORT=high\n", "utf8");
      loadEnvironment({ baseDir: dir, envSuffix: "ask" });
      expect(process.env.OPENAI_DEFAULT_EFFORT).toBe("high");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(".env と同じ値が事前設定されていても .env.{suffix} の値で上書きされる", () => {
    process.env[targetEnv] = "medium";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-load-env-"));
    try {
      fs.writeFileSync(path.join(dir, ".env"), "OPENAI_DEFAULT_EFFORT=medium\n", "utf8");
      fs.writeFileSync(path.join(dir, ".env.ask"), "OPENAI_DEFAULT_EFFORT=high\n", "utf8");
      loadEnvironment({ baseDir: dir, envSuffix: "ask" });
      expect(process.env.OPENAI_DEFAULT_EFFORT).toBe("high");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("既に環境変数が設定されていれば維持される", () => {
    process.env.OPENAI_DEFAULT_EFFORT = "low";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-load-env-"));
    try {
      fs.writeFileSync(path.join(dir, ".env"), "OPENAI_DEFAULT_EFFORT=medium\n", "utf8");
      fs.writeFileSync(path.join(dir, ".env.sql"), "OPENAI_DEFAULT_EFFORT=high\n", "utf8");
      loadEnvironment({ baseDir: dir, envSuffix: "sql" });
      expect(process.env.OPENAI_DEFAULT_EFFORT).toBe("low");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it("HOME が無い状態でもユーザーディレクトリを利用して展開する", () => {
    const fallbackHome = path.join(tempDir!, "fallback-prompts");
    fs.mkdirSync(fallbackHome, { recursive: true });

    const originalHomedir = os.homedir;
    (os as unknown as { homedir: () => string }).homedir = () => fallbackHome;

    delete process.env.HOME;
    process.env.GPT_5_CLI_PROMPTS_DIR = "~/prompts";

    try {
      const resolved = resolvePromptsDir("/default/prompts");
      expect(resolved).toBe(path.resolve(path.join(fallbackHome, "prompts")));
    } finally {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
      process.env.HOME = tempDir!;
    }
  });

  it("ConfigEnv を利用してパスを解決する (仕様記述)", () => {
    // TODO: 実装フェーズで内容を追加する。
  });
});

describe("loadDefaults", () => {
  it("履歴パスが未設定ならエラーになる", () => {
    expect(() => loadDefaults()).toThrow(
      "GPT_5_CLI_HISTORY_INDEX_FILE must be configured via environment files.",
    );
  });

  it("既定値を返す", () => {
    process.env.GPT_5_CLI_HISTORY_INDEX_FILE = "~/history/default.json";
    const defaults = loadDefaults();
    expect(defaults.modelMain).toBe("gpt-5");
    expect(defaults.modelMini).toBe("gpt-5-mini");
    expect(defaults.modelNano).toBe("gpt-5-nano");
    expect(defaults.effort).toBe("low");
    expect(defaults.verbosity).toBe("low");
    expect(defaults.historyIndexPath).toBe(
      path.resolve(path.join(process.env.HOME!, "history/default.json")),
    );
    expect(defaults.promptsDir).toBe(path.join(ROOT_DIR, "prompts"));
    expect(defaults.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it("環境変数を反映する", () => {
    process.env.OPENAI_MODEL_MAIN = "main-x";
    process.env.OPENAI_MODEL_MINI = "mini-x";
    process.env.OPENAI_MODEL_NANO = "nano-x";
    process.env.OPENAI_DEFAULT_EFFORT = "high";
    process.env.OPENAI_DEFAULT_VERBOSITY = "medium";
    process.env.GPT_5_CLI_HISTORY_INDEX_FILE = "~/data/hist.json";
    process.env.GPT_5_CLI_PROMPTS_DIR = "~/data/prompts";
    process.env.GPT_5_CLI_MAX_ITERATIONS = "5";
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
    expect(defaults.maxIterations).toBe(5);
  });

  it("ConfigEnv を引数に受け取って既定値を構築する (仕様記述)", () => {
    // TODO: 実装フェーズで内容を追加する。
  });
});
