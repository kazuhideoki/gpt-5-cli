/**
 * ConfigEnv の読み込み挙動を検証するテストスイート。
 * 仕様確認のためのテストケースを先に宣言しておき、TDD のフェーズに沿って実装する。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigEnv } from "./config-env.js";

const TMP_DIR_PREFIX = "config-env-test";

describe("ConfigEnv", () => {
  let tmpDirPath: string;

  beforeEach(async () => {
    tmpDirPath = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", TMP_DIR_PREFIX));
  });

  afterEach(async () => {
    await fs.rm(tmpDirPath, { recursive: true, force: true });
  });

  it("ベースの .env が存在しない場合は空の環境を構築する", async () => {
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect([...env.entries()]).toEqual([]);
    expect(env.has("ANY_KEY")).toBe(false);
    expect(env.get("ANY_KEY")).toBeUndefined();
  });

  it("ベースの .env からキーと値を読み込む", async () => {
    const baseEnvPath = path.join(tmpDirPath, ".env");
    await fs.writeFile(baseEnvPath, "FOO=bar\nEMPTY_VALUE=\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.get("FOO")).toBe("bar");
    expect(env.get("EMPTY_VALUE")).toBe("");
    expect(env.has("FOO")).toBe(true);
  });

  it("suffix が指定され存在する場合は .env.{suffix} の値で上書きする", async () => {
    await fs.writeFile(path.join(tmpDirPath, ".env"), "FOO=base\nBAR=baz\n");
    await fs.writeFile(path.join(tmpDirPath, ".env.ask"), "FOO=override\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath, envSuffix: "ask" });
    expect(env.get("FOO")).toBe("override");
    expect(env.get("BAR")).toBe("baz");
  });

  it("suffix が指定されていても .env.{suffix} が存在しない場合はベースの値を維持する", async () => {
    await fs.writeFile(path.join(tmpDirPath, ".env"), "BAZ=qux\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath, envSuffix: "d2" });
    expect(env.get("BAZ")).toBe("qux");
  });

  it("baseDir オプションで探索ディレクトリを切り替えられる", async () => {
    const altDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", `${TMP_DIR_PREFIX}-alt`),
    );
    await fs.writeFile(path.join(altDir, ".env"), "ALT=value\n");
    const env = await ConfigEnv.create({ baseDir: altDir });
    expect(env.get("ALT")).toBe("value");
    await fs.rm(altDir, { recursive: true, force: true });
  });

  it("get/has/entries で保持している値へアクセスできる", async () => {
    const baseEnvPath = path.join(tmpDirPath, ".env");
    await fs.writeFile(baseEnvPath, "FOO=bar\nBAR=baz\n");
    const env = await ConfigEnv.create({ baseDir: tmpDirPath });
    expect(env.has("FOO")).toBe(true);
    expect(env.has("UNKNOWN")).toBe(false);
    expect(env.get("BAR")).toBe("baz");
    expect([...env.entries()]).toEqual([
      ["FOO", "bar"],
      ["BAR", "baz"],
    ]);
  });
});
