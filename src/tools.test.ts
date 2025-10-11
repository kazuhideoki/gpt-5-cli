import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeFunctionToolCall, FUNCTION_TOOLS, resolveWorkspacePath } from "./tools.js";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";

function createCall(name: string, args: Record<string, unknown>): ResponseFunctionToolCall {
  return {
    type: "function_call",
    id: `call-${name}`,
    call_id: `call-${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

describe("FUNCTION_TOOLS", () => {
  it("含まれるツール名が期待通り", () => {
    const toolNames = FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual(["read_file", "write_file", "d2_check", "d2_fmt"]);
  });
});

describe("resolveWorkspacePath", () => {
  it("ワークスペース内のファイルを許可する", () => {
    const workspace = path.join(process.cwd(), "tmp-workspace");
    const resolved = resolveWorkspacePath("diagram.d2", workspace);
    expect(resolved).toBe(path.join(workspace, "diagram.d2"));
  });

  it("ルートディレクトリのワークスペースでもファイルを許可する", () => {
    const root = path.parse(process.cwd()).root;
    const resolved = resolveWorkspacePath("diagram.d2", root);
    expect(resolved).toBe(path.resolve(root, "diagram.d2"));
  });

  it("ワークスペース外の参照は拒否する", () => {
    const workspace = path.join(process.cwd(), "tmp-workspace");
    expect(() => resolveWorkspacePath("../outside.txt", workspace)).toThrow(
      "Access to path outside workspace is not allowed: ../outside.txt",
    );
  });
});

describe("executeFunctionToolCall", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-cli-tools-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("ファイルの書き込みと読み取りを往復できる", async () => {
    const writeCall = createCall("write_file", {
      path: "diagram.d2",
      content: "a -> b",
    });
    const writeResult = JSON.parse(
      await executeFunctionToolCall(writeCall, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(writeResult.success).toBe(true);
    expect(writeResult.path).toBe("diagram.d2");

    const readCall = createCall("read_file", { path: "diagram.d2" });
    const readResult = JSON.parse(
      await executeFunctionToolCall(readCall, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(readResult.success).toBe(true);
    expect(readResult.content).toBe("a -> b");
  });

  it("ワークスペース外のパスは拒否される", async () => {
    const readCall = createCall("read_file", { path: "../secret.txt" });
    const result = JSON.parse(
      await executeFunctionToolCall(readCall, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("outside workspace");
  });

  it("未知のツール名は失敗を返す", async () => {
    const call: ResponseFunctionToolCall = {
      type: "function_call",
      id: "call-unknown",
      call_id: "call-unknown",
      name: "unknown_tool",
      arguments: "{}",
    };
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown tool");
  });
});
