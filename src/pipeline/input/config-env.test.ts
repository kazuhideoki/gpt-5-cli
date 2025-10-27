/**
 * ConfigEnv の読み込み挙動を検証するテストスイート。
 * 仕様確認のためのテストケースを先に宣言しておき、TDD のフェーズに沿って実装する。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigEnv, CONFIG_ENV_KNOWN_KEYS, configEnvSchema } from "./config-env.js";

const TMP_DIR_PREFIX = "config-env-test";
const KNOWN_KEY_SET = new Set(CONFIG_ENV_KNOWN_KEYS);

function snapshotProcessEnv(): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && KNOWN_KEY_SET.has(key)) {
      snapshot.set(key, value);
    }
  }
  return snapshot;
}

function expectEnvIncludesBaseline(env: ConfigEnv, baseline: Map<string, string>): void {
  for (const [key, value] of baseline) {
    expect(env.get(key)).toBe(value);
  }
}

function expectEnvMatchesBaseline(env: ConfigEnv, baseline: Map<string, string>): void {
  const entries = [...env.entries()];
  expect(entries).toHaveLength(baseline.size);
  for (const [key, value] of entries) {
    expect(baseline.get(key)).toBe(value);
  }
  expectEnvIncludesBaseline(env, baseline);
}

describe("ConfigEnv", () => {
  let tmpDirPath: string;

  beforeEach(async () => {
    tmpDirPath = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", TMP_DIR_PREFIX));
  });

  afterEach(async () => {
    await fs.rm(tmpDirPath, { recursive: true, force: true });
  });

  it("ベースの .env が存在しない場合は空の環境を構築する", async () => {
    const baseline = snapshotProcessEnv();
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expectEnvMatchesBaseline(env, baseline);
  });

  it("ベースの .env からキーと値を読み込む", async () => {
    const originalMain = process.env.OPENAI_MODEL_MAIN;
    const originalOutputDir = process.env.GPT_5_CLI_OUTPUT_DIR;
    delete process.env.OPENAI_MODEL_MAIN;
    delete process.env.GPT_5_CLI_OUTPUT_DIR;
    try {
      const baseline = snapshotProcessEnv();
      const baseEnvPath = path.join(tmpDirPath, ".env");
      await fs.writeFile(baseEnvPath, "OPENAI_MODEL_MAIN=gpt-5\nGPT_5_CLI_OUTPUT_DIR=\n");
      const env = await ConfigEnv.create({ baseDir: tmpDirPath });
      expect(env.get("OPENAI_MODEL_MAIN")).toBe("gpt-5");
      expect(env.get("GPT_5_CLI_OUTPUT_DIR")).toBe("");
      expect(env.has("OPENAI_MODEL_MAIN")).toBe(true);
      expectEnvIncludesBaseline(env, baseline);
    } finally {
      if (originalMain === undefined) {
        delete process.env.OPENAI_MODEL_MAIN;
      } else {
        process.env.OPENAI_MODEL_MAIN = originalMain;
      }
      if (originalOutputDir === undefined) {
        delete process.env.GPT_5_CLI_OUTPUT_DIR;
      } else {
        process.env.GPT_5_CLI_OUTPUT_DIR = originalOutputDir;
      }
    }
  });

  it("suffix が指定され存在する場合は .env.{suffix} の値で上書きする", async () => {
    const originalMain = process.env.OPENAI_MODEL_MAIN;
    const originalMini = process.env.OPENAI_MODEL_MINI;
    delete process.env.OPENAI_MODEL_MAIN;
    delete process.env.OPENAI_MODEL_MINI;
    try {
      const baseline = snapshotProcessEnv();
      await fs.writeFile(
        path.join(tmpDirPath, ".env"),
        "OPENAI_MODEL_MAIN=base\nOPENAI_MODEL_MINI=mini\n",
      );
      await fs.writeFile(path.join(tmpDirPath, ".env.ask"), "OPENAI_MODEL_MAIN=override\n");
      const env = await ConfigEnv.create({ baseDir: tmpDirPath, envSuffix: "ask" });
      expect(env.get("OPENAI_MODEL_MAIN")).toBe("override");
      expect(env.get("OPENAI_MODEL_MINI")).toBe("mini");
      expectEnvIncludesBaseline(env, baseline);
    } finally {
      if (originalMain === undefined) {
        delete process.env.OPENAI_MODEL_MAIN;
      } else {
        process.env.OPENAI_MODEL_MAIN = originalMain;
      }
      if (originalMini === undefined) {
        delete process.env.OPENAI_MODEL_MINI;
      } else {
        process.env.OPENAI_MODEL_MINI = originalMini;
      }
    }
  });

  it("suffix が指定されていても .env.{suffix} が存在しない場合はベースの値を維持する", async () => {
    const originalEffort = process.env.OPENAI_DEFAULT_EFFORT;
    delete process.env.OPENAI_DEFAULT_EFFORT;
    try {
      const baseline = snapshotProcessEnv();
      await fs.writeFile(path.join(tmpDirPath, ".env"), "OPENAI_DEFAULT_EFFORT=low\n");
      const env = await ConfigEnv.create({ baseDir: tmpDirPath, envSuffix: "d2" });
      expect(env.get("OPENAI_DEFAULT_EFFORT")).toBe("low");
      expectEnvIncludesBaseline(env, baseline);
    } finally {
      if (originalEffort === undefined) {
        delete process.env.OPENAI_DEFAULT_EFFORT;
      } else {
        process.env.OPENAI_DEFAULT_EFFORT = originalEffort;
      }
    }
  });

  it("baseDir オプションで探索ディレクトリを切り替えられる", async () => {
    const originalOutputDir = process.env.GPT_5_CLI_OUTPUT_DIR;
    delete process.env.GPT_5_CLI_OUTPUT_DIR;
    const altDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", `${TMP_DIR_PREFIX}-alt`),
    );
    try {
      const baseline = snapshotProcessEnv();
      await fs.writeFile(path.join(altDir, ".env"), "GPT_5_CLI_OUTPUT_DIR=output\n");
      const env = await ConfigEnv.create({ baseDir: altDir });
      expect(env.get("GPT_5_CLI_OUTPUT_DIR")).toBe("output");
      expectEnvIncludesBaseline(env, baseline);
    } finally {
      await fs.rm(altDir, { recursive: true, force: true });
      if (originalOutputDir === undefined) {
        delete process.env.GPT_5_CLI_OUTPUT_DIR;
      } else {
        process.env.GPT_5_CLI_OUTPUT_DIR = originalOutputDir;
      }
    }
  });

  it("get/has/entries で保持している値へアクセスできる", async () => {
    const originalMain = process.env.OPENAI_MODEL_MAIN;
    const originalMini = process.env.OPENAI_MODEL_MINI;
    delete process.env.OPENAI_MODEL_MAIN;
    delete process.env.OPENAI_MODEL_MINI;
    const baseline = snapshotProcessEnv();
    const baseEnvPath = path.join(tmpDirPath, ".env");
    await fs.writeFile(baseEnvPath, "OPENAI_MODEL_MAIN=gpt-5\nOPENAI_MODEL_MINI=gpt-5-mini\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.has("OPENAI_MODEL_MAIN")).toBe(true);
    expect(env.has("UNKNOWN")).toBe(false);
    expect(env.get("OPENAI_MODEL_MINI")).toBe("gpt-5-mini");
    const entries = [...env.entries()];
    expect(entries).toEqual(
      expect.arrayContaining([
        ["OPENAI_MODEL_MAIN", "gpt-5"],
        ["OPENAI_MODEL_MINI", "gpt-5-mini"],
      ]),
    );
    expectEnvIncludesBaseline(env, baseline);
    if (originalMain === undefined) {
      delete process.env.OPENAI_MODEL_MAIN;
    } else {
      process.env.OPENAI_MODEL_MAIN = originalMain;
    }
    if (originalMini === undefined) {
      delete process.env.OPENAI_MODEL_MINI;
    } else {
      process.env.OPENAI_MODEL_MINI = originalMini;
    }
  });

  it("既存の process.env で指定された値を優先する", async () => {
    const originalPromptsDir = process.env.GPT_5_CLI_PROMPTS_DIR;
    const originalModelMain = process.env.OPENAI_MODEL_MAIN;
    try {
      process.env.GPT_5_CLI_PROMPTS_DIR = "/tmp/prompts";
      process.env.OPENAI_MODEL_MAIN = "process-original";
      await fs.writeFile(
        path.join(tmpDirPath, ".env"),
        "OPENAI_MODEL_MAIN=file-value\nOPENAI_MODEL_MINI=file-only\n",
      );
      const env = await ConfigEnv.create({ baseDir: tmpDirPath });
      expect(env.get("GPT_5_CLI_PROMPTS_DIR")).toBe("/tmp/prompts");
      expect(env.get("OPENAI_MODEL_MAIN")).toBe("process-original");
      expect(env.get("OPENAI_MODEL_MINI")).toBe("file-only");
    } finally {
      if (originalPromptsDir === undefined) {
        delete process.env.GPT_5_CLI_PROMPTS_DIR;
      } else {
        process.env.GPT_5_CLI_PROMPTS_DIR = originalPromptsDir;
      }
      if (originalModelMain === undefined) {
        delete process.env.OPENAI_MODEL_MAIN;
      } else {
        process.env.OPENAI_MODEL_MAIN = originalModelMain;
      }
    }
  });

  it("未知のキーは保持しない", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const baseline = snapshotProcessEnv();
      await fs.writeFile(path.join(tmpDirPath, ".env"), "UNKNOWN=value\nOPENAI_API_KEY=token\n");
      const env = await ConfigEnv.create({ baseDir: tmpDirPath });
      expect(env.has("UNKNOWN")).toBe(false);
      expect(env.get("UNKNOWN")).toBeUndefined();
      expect(env.get("OPENAI_API_KEY")).toBe("token");
      expectEnvIncludesBaseline(env, baseline);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });
});

describe("configEnvSchema", () => {
  it("未知の環境変数キーは strip される", () => {
    const result = configEnvSchema.parse({
      OPENAI_API_KEY: "test",
      UNKNOWN_KEY: "ignored",
    });
    expect(result).toEqual({ OPENAI_API_KEY: "test" });
  });

  it("既知キーのみで構成されたオブジェクトを返す", () => {
    const parsed = configEnvSchema.parse({
      OPENAI_MODEL_MAIN: "main",
      GPT_5_CLI_HISTORY_INDEX_FILE: "/tmp/history.json",
      SQRUFF_BIN: "sqruff",
    });
    expect(parsed).toEqual({
      OPENAI_MODEL_MAIN: "main",
      GPT_5_CLI_HISTORY_INDEX_FILE: "/tmp/history.json",
      SQRUFF_BIN: "sqruff",
    });
  });

  it("型レベルで既知キーを扱える", () => {
    const snapshot = configEnvSchema.parse({ OPENAI_API_KEY: "abc" });
    const value: string | undefined = snapshot.OPENAI_API_KEY;
    expect(value).toBe("abc");
  });
});
