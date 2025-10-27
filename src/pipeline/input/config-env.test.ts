/**
 * ConfigEnv の読み込み挙動を検証するテストスイート。
 * 仕様確認のためのテストケースを先に宣言しておき、TDD のフェーズに沿って実装する。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigEnv } from "./config-env.js";

const TMP_DIR_PREFIX = "config-env-test";

function snapshotProcessEnv(): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
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
    const baseline = snapshotProcessEnv();
    const baseEnvPath = path.join(tmpDirPath, ".env");
    await fs.writeFile(baseEnvPath, "FOO=bar\nEMPTY_VALUE=\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.get("FOO")).toBe("bar");
    expect(env.get("EMPTY_VALUE")).toBe("");
    expect(env.has("FOO")).toBe(true);
    expectEnvIncludesBaseline(env, baseline);
  });

  it("suffix が指定され存在する場合は .env.{suffix} の値で上書きする", async () => {
    const baseline = snapshotProcessEnv();
    await fs.writeFile(path.join(tmpDirPath, ".env"), "FOO=base\nBAR=baz\n");
    await fs.writeFile(path.join(tmpDirPath, ".env.ask"), "FOO=override\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath, envSuffix: "ask" });
    expect(env.get("FOO")).toBe("override");
    expect(env.get("BAR")).toBe("baz");
    expectEnvIncludesBaseline(env, baseline);
  });

  it("suffix が指定されていても .env.{suffix} が存在しない場合はベースの値を維持する", async () => {
    const baseline = snapshotProcessEnv();
    await fs.writeFile(path.join(tmpDirPath, ".env"), "BAZ=qux\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath, envSuffix: "d2" });
    expect(env.get("BAZ")).toBe("qux");
    expectEnvIncludesBaseline(env, baseline);
  });

  it("baseDir オプションで探索ディレクトリを切り替えられる", async () => {
    const baseline = snapshotProcessEnv();
    const altDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", `${TMP_DIR_PREFIX}-alt`),
    );
    await fs.writeFile(path.join(altDir, ".env"), "ALT=value\n");
    const env = await ConfigEnv.create({ baseDir: altDir });
    expect(env.get("ALT")).toBe("value");
    expectEnvIncludesBaseline(env, baseline);
    await fs.rm(altDir, { recursive: true, force: true });
  });

  it("get/has/entries で保持している値へアクセスできる", async () => {
    const originalFoo = process.env.FOO;
    const originalBar = process.env.BAR;
    delete process.env.FOO;
    delete process.env.BAR;
    const baseline = snapshotProcessEnv();
    const baseEnvPath = path.join(tmpDirPath, ".env");
    await fs.writeFile(baseEnvPath, "FOO=bar\nBAR=baz\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.has("FOO")).toBe(true);
    expect(env.has("UNKNOWN")).toBe(false);
    expect(env.get("BAR")).toBe("baz");
    const entries = [...env.entries()];
    expect(entries).toEqual(
      expect.arrayContaining([
        ["FOO", "bar"],
        ["BAR", "baz"],
      ]),
    );
    expectEnvIncludesBaseline(env, baseline);
    if (originalFoo === undefined) {
      delete process.env.FOO;
    } else {
      process.env.FOO = originalFoo;
    }
    if (originalBar === undefined) {
      delete process.env.BAR;
    } else {
      process.env.BAR = originalBar;
    }
  });

  it("既存の process.env で指定された値を優先する", async () => {
    const originalFromProcess = process.env.FROM_PROCESS;
    const originalOverridden = process.env.OVERRIDDEN;
    try {
      process.env.FROM_PROCESS = "process-value";
      process.env.OVERRIDDEN = "process-original";
      await fs.writeFile(
        path.join(tmpDirPath, ".env"),
        "OVERRIDDEN=file-value\nONLY_FILE=file-only\n",
      );
      const env = await ConfigEnv.create({ baseDir: tmpDirPath });
      expect(env.get("FROM_PROCESS")).toBe("process-value");
      expect(env.get("OVERRIDDEN")).toBe("process-original");
      expect(env.get("ONLY_FILE")).toBe("file-only");
    } finally {
      if (originalFromProcess === undefined) {
        delete process.env.FROM_PROCESS;
      } else {
        process.env.FROM_PROCESS = originalFromProcess;
      }
      if (originalOverridden === undefined) {
        delete process.env.OVERRIDDEN;
      } else {
        process.env.OVERRIDDEN = originalOverridden;
      }
    }
  });
});

describe("configEnvSchema", () => {
  it.todo("未知の環境変数キーは strip される");
  it.todo("既知キーのみで構成されたオブジェクトを返す");
  it.todo("string オーバーロード経由でも型安全な値が取得できる");
});
