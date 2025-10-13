import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPrompt, resolvePromptPath } from "./prompts.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-cli-prompts-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  // no-op
});

describe("resolvePromptPath", () => {
  it("モードが未指定なら ask.md を指す", () => {
    const resolved = resolvePromptPath(undefined, tempDir);
    expect(resolved).toBe(path.join(tempDir, "ask.md"));
  });

  it("空文字列なら ask.md を指す", () => {
    const resolved = resolvePromptPath("   ", tempDir);
    expect(resolved).toBe(path.join(tempDir, "ask.md"));
  });

  it("モードに応じたファイル名を返す", () => {
    const resolved = resolvePromptPath("d2", tempDir);
    expect(resolved).toBe(path.join(tempDir, "d2.md"));
  });
});

describe("loadPrompt", () => {
  it("存在しない場合は undefined", () => {
    const result = loadPrompt("ask", tempDir);
    expect(result).toBeUndefined();
  });

  it("空ファイルなら undefined", () => {
    fs.writeFileSync(path.join(tempDir, "ask.md"), "   \n", "utf8");
    expect(loadPrompt("ask", tempDir)).toBeUndefined();
  });

  it("内容があれば返す", () => {
    fs.writeFileSync(path.join(tempDir, "ask.md"), "こんにちは\n", "utf8");
    expect(loadPrompt("ask", tempDir)).toBe("こんにちは\n");
  });
});
