import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DEFAULT_OUTPUT_DIR_ENV, deliverOutput, generateDefaultOutputPath } from "./output.js";

interface MockStdin extends EventEmitter {
  end: (chunk: string, encoding?: BufferEncoding) => void;
}

interface MockChildProcess extends EventEmitter {
  stdin: MockStdin;
}

const copyInvocations: string[] = [];

mock.module("node:child_process", () => ({
  spawn: () => {
    const child = new EventEmitter() as MockChildProcess;
    const stdin = new EventEmitter() as MockStdin;
    stdin.end = (chunk: string, _encoding?: BufferEncoding) => {
      copyInvocations.push(chunk);
      child.emit("close", 0);
    };
    child.stdin = stdin;
    return child;
  },
}));

describe("deliverOutput", () => {
  let tmpDir: string;

  beforeEach(async () => {
    copyInvocations.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "deliver-output-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.restore();
  });

  test("copy=true の場合は本文を既定でコピーする", async () => {
    await deliverOutput({
      content: "summary text",
      copy: true,
      cwd: tmpDir,
    });
    expect(copyInvocations).toEqual(["summary text"]);
  });

  test("copySource が file の場合はファイルの内容をコピーする", async () => {
    const artifactPath = path.join(tmpDir, "diagram.d2");
    await fs.writeFile(artifactPath, "diagram body", { encoding: "utf8" });

    await deliverOutput({
      content: "summary text",
      copy: true,
      cwd: tmpDir,
      copySource: {
        type: "file",
        filePath: "diagram.d2",
      },
    });

    expect(copyInvocations).toEqual(["diagram body"]);
  });

  test("copySource が file でファイルが存在しない場合はエラーになる", async () => {
    await expect(
      deliverOutput({
        content: "summary text",
        copy: true,
        cwd: tmpDir,
        copySource: {
          type: "file",
          filePath: "missing.d2",
        },
      }),
    ).rejects.toThrow("Error: --copy の対象ファイルが存在しません: missing.d2");

    expect(copyInvocations).toEqual([]);
  });
});

describe("generateDefaultOutputPath", () => {
  let originalEnv: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalEnv = process.env[DEFAULT_OUTPUT_DIR_ENV];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt5-output-"));
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env[DEFAULT_OUTPUT_DIR_ENV];
    } else {
      process.env[DEFAULT_OUTPUT_DIR_ENV] = originalEnv;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("ワークスペース出力ディレクトリを既定で利用する", () => {
    const { relativePath, absolutePath } = generateDefaultOutputPath({
      mode: "d2",
      extension: "d2",
      cwd: tempDir,
    });
    expect(relativePath.startsWith(`output${path.sep}d2${path.sep}`)).toBe(true);
    expect(absolutePath.startsWith(path.join(tempDir, "output", "d2"))).toBe(true);
  });

  test("環境変数で指定したディレクトリを基準にする", () => {
    process.env[DEFAULT_OUTPUT_DIR_ENV] = "custom/dir";
    const { relativePath, absolutePath } = generateDefaultOutputPath({
      mode: "sql",
      extension: "sql",
      cwd: tempDir,
    });
    expect(relativePath.startsWith(`custom${path.sep}dir${path.sep}`)).toBe(true);
    expect(absolutePath.startsWith(path.join(tempDir, "custom", "dir"))).toBe(true);
  });

  test("ワークスペース外を指す環境変数はエラーにする", () => {
    process.env[DEFAULT_OUTPUT_DIR_ENV] = path.join("..", "outside");
    expect(() =>
      generateDefaultOutputPath({ mode: "mermaid", extension: "mmd", cwd: tempDir }),
    ).toThrow(/GPT_5_CLI_OUTPUT_DIR/u);
  });
});
