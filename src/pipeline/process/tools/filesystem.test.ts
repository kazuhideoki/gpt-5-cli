import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  resolveWorkspacePath,
  type ToolExecutionContext,
} from "./index.js";

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-cli-fs-"));
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

const context: ToolExecutionContext = {
  cwd: "",
  log: () => {},
};

describe("resolveWorkspacePath", () => {
  it("ワークスペース内のファイルを許可する", () => {
    const resolved = resolveWorkspacePath("diagram.d2", workspaceDir);
    expect(resolved).toBe(path.join(workspaceDir, "diagram.d2"));
  });

  it("ルートディレクトリのワークスペースでもファイルを許可する", () => {
    const root = path.parse(process.cwd()).root;
    const resolved = resolveWorkspacePath("diagram.d2", root);
    expect(resolved).toBe(path.resolve(root, "diagram.d2"));
  });

  it("ワークスペース外の参照は拒否する", () => {
    expect(() => resolveWorkspacePath("../outside.txt", workspaceDir)).toThrow(
      "Access to path outside workspace is not allowed: ../outside.txt",
    );
  });
});

describe("READ_FILE / WRITE_FILE", () => {
  beforeEach(() => {
    context.cwd = workspaceDir;
  });

  it("ファイルの書き込みと読み取りを往復できる", async () => {
    const writeResult = await WRITE_FILE_TOOL.handler(
      { path: "diagram.d2", content: "a -> b" },
      context,
    );
    expect(writeResult.success).toBe(true);
    expect(writeResult.path).toBe("diagram.d2");

    const readResult = await READ_FILE_TOOL.handler({ path: "diagram.d2" }, context);
    expect(readResult.success).toBe(true);
    expect(readResult.content).toBe("a -> b");
  });

  it("ワークスペース外のパスは拒否される", async () => {
    await expect(READ_FILE_TOOL.handler({ path: "../secret.txt" }, context)).rejects.toThrow(
      "Access to path outside workspace is not allowed",
    );
  });
});
