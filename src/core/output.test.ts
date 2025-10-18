import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

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

const { deliverOutput } = await import("./output.js");

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
