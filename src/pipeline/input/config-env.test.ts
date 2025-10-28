/**
 * ConfigEnv の読み込み挙動を検証するテストスイート。
 * 仕様確認のためのテストケースを先に宣言しておき、TDD のフェーズに沿って実装する。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigEnv, CONFIG_ENV_KNOWN_KEYS, configEnvSchema } from "./config-env.js";
import type { ConfigEnvKey } from "./config-env.js";

const TMP_DIR_PREFIX = "config-env-test";
const KNOWN_KEY_SET = new Set(CONFIG_ENV_KNOWN_KEYS);
const ISOLATED_ENV_KEYS: readonly ConfigEnvKey[] = [
  "SQRUFF_BIN",
  "GPT_5_CLI_MAX_ITERATIONS",
  "GPT_5_CLI_HISTORY_INDEX_FILE",
  "OPENAI_DEFAULT_EFFORT",
  "OPENAI_DEFAULT_VERBOSITY",
  "GPT_5_CLI_OUTPUT_DIR",
  "OPENAI_MODEL_MAIN",
  "OPENAI_MODEL_MINI",
  "GPT_5_CLI_PROMPTS_DIR",
];
const ENV_RESET_KEYS: readonly ConfigEnvKey[] = [...ISOLATED_ENV_KEYS, "HOME"];

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
  let envBackup: Map<ConfigEnvKey, string | undefined>;

  beforeEach(async () => {
    envBackup = new Map();
    for (const key of ENV_RESET_KEYS) {
      envBackup.set(key, process.env[key]);
      delete process.env[key];
    }
    tmpDirPath = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", TMP_DIR_PREFIX));
  });

  afterEach(async () => {
    for (const [key, value] of envBackup) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tmpDirPath, { recursive: true, force: true });
  });

  it("ベースの .env が存在しない場合は空の環境を構築する", async () => {
    const baseline = snapshotProcessEnv();
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expectEnvMatchesBaseline(env, baseline);
  });

  it("ベースの .env からキーと値を読み込む", async () => {
    const baseline = snapshotProcessEnv();
    const baseEnvPath = path.join(tmpDirPath, ".env");
    await fs.writeFile(baseEnvPath, "SQRUFF_BIN=sqruff\nGPT_5_CLI_MAX_ITERATIONS=5\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.get("SQRUFF_BIN")).toBe("sqruff");
    expect(env.get("GPT_5_CLI_MAX_ITERATIONS")).toBe("5");
    expect(env.has("SQRUFF_BIN")).toBe(true);
    expectEnvIncludesBaseline(env, baseline);
  });

  it("suffix が指定され存在する場合は .env.{suffix} の値で上書きする", async () => {
    const baseline = snapshotProcessEnv();
    await fs.writeFile(
      path.join(tmpDirPath, ".env"),
      "GPT_5_CLI_HISTORY_INDEX_FILE=/tmp/history.json\nOPENAI_DEFAULT_EFFORT=low\n",
    );
    await fs.writeFile(
      path.join(tmpDirPath, ".env.ask"),
      "GPT_5_CLI_HISTORY_INDEX_FILE=/tmp/history-ask.json\n",
    );
    const env = await ConfigEnv.create({ baseDir: tmpDirPath, envSuffix: "ask" });
    expect(env.get("GPT_5_CLI_HISTORY_INDEX_FILE")).toBe("/tmp/history-ask.json");
    expect(env.get("OPENAI_DEFAULT_EFFORT")).toBe("low");
    expectEnvIncludesBaseline(env, baseline);
  });

  it("suffix が指定されていても .env.{suffix} が存在しない場合はベースの値を維持する", async () => {
    const baseline = snapshotProcessEnv();
    await fs.writeFile(path.join(tmpDirPath, ".env"), "GPT_5_CLI_OUTPUT_DIR=output\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath, envSuffix: "d2" });
    expect(env.get("GPT_5_CLI_OUTPUT_DIR")).toBe("output");
    expectEnvIncludesBaseline(env, baseline);
  });

  it("baseDir オプションで探索ディレクトリを切り替えられる", async () => {
    const altDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", `${TMP_DIR_PREFIX}-alt`),
    );
    try {
      const baseline = snapshotProcessEnv();
      await fs.writeFile(path.join(altDir, ".env"), "OPENAI_DEFAULT_VERBOSITY=medium\n");
      const env = await ConfigEnv.create({ baseDir: altDir });
      expect(env.get("OPENAI_DEFAULT_VERBOSITY")).toBe("medium");
      expectEnvIncludesBaseline(env, baseline);
    } finally {
      await fs.rm(altDir, { recursive: true, force: true });
    }
  });

  it("get/has/entries で保持している値へアクセスできる", async () => {
    const baseline = snapshotProcessEnv();
    const baseEnvPath = path.join(tmpDirPath, ".env");
    await fs.writeFile(baseEnvPath, "SQRUFF_BIN=sqruff\nOPENAI_MODEL_MINI=gpt-5-mini\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.has("SQRUFF_BIN")).toBe(true);
    expect(env.has("UNKNOWN")).toBe(false);
    expect(env.get("OPENAI_MODEL_MINI")).toBe("gpt-5-mini");
    const entries = [...env.entries()];
    expect(entries).toEqual(
      expect.arrayContaining([
        ["SQRUFF_BIN", "sqruff"],
        ["OPENAI_MODEL_MINI", "gpt-5-mini"],
      ]),
    );
    expectEnvIncludesBaseline(env, baseline);
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
    const baseline = snapshotProcessEnv();
    await fs.writeFile(path.join(tmpDirPath, ".env"), "UNKNOWN=value\nSQRUFF_BIN=sqruff\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.has("UNKNOWN")).toBe(false);
    expect(env.get("UNKNOWN")).toBeUndefined();
    expect(env.get("SQRUFF_BIN")).toBe("sqruff");
    expectEnvIncludesBaseline(env, baseline);
  });

  it("process.env.HOME の値を ConfigEnv が保持する", async () => {
    const fakeHome = path.join(tmpDirPath, "home-from-process");
    process.env.HOME = fakeHome;
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.get("HOME")).toBe(fakeHome);
  });

  it(".env に記載された HOME を ConfigEnv が読み込む", async () => {
    delete process.env.HOME;
    await fs.writeFile(path.join(tmpDirPath, ".env"), "HOME=/tmp/config-env-home\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.get("HOME")).toBe("/tmp/config-env-home");
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
