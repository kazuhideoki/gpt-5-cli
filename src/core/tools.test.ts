import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCoreToolRuntime,
  resolveWorkspacePath,
  type ToolRegistration,
  type ToolResult,
} from "./tools.js";
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

const { tools: FUNCTION_TOOLS, execute: executeFunctionToolCall } = createCoreToolRuntime();

const ORIGINAL_POSTGRES_DSN = process.env.POSTGRES_DSN;
const ORIGINAL_SQRUFF_BIN = process.env.SQRUFF_BIN;

afterEach(() => {
  if (ORIGINAL_POSTGRES_DSN === undefined) {
    delete process.env.POSTGRES_DSN;
  } else {
    process.env.POSTGRES_DSN = ORIGINAL_POSTGRES_DSN;
  }

  if (ORIGINAL_SQRUFF_BIN === undefined) {
    delete process.env.SQRUFF_BIN;
  } else {
    process.env.SQRUFF_BIN = ORIGINAL_SQRUFF_BIN;
  }
});

describe("FUNCTION_TOOLS", () => {
  it("含まれるツール名が期待通り", () => {
    const toolNames = FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual([
      "read_file",
      "write_file",
      "d2_check",
      "d2_fmt",
      "sql_fetch_schema",
      "sql_dry_run",
      "sql_format",
    ]);
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

  it("CLI固有のツールを差し込める", async () => {
    const extraTool: ToolRegistration = {
      definition: {
        type: "function",
        strict: true,
        name: "custom_echo",
        description: "Echo back the provided message.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to echo.",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
      },
      handler: async (args: any): Promise<ToolResult> => ({
        success: true,
        message: String(args?.message ?? ""),
      }),
    };

    const { tools, execute } = createCoreToolRuntime([extraTool]);
    expect(tools.map((tool) => tool.name)).toContain("custom_echo");

    const call = createCall("custom_echo", { message: "hello" });
    const result = JSON.parse(
      await execute(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe("hello");
  });

  it("sql_dry_run は非SELECT文を拒否する", async () => {
    const call = createCall("sql_dry_run", { query: "INSERT INTO users VALUES (1)" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SELECT");
  });

  it("sql_dry_run は DSN 未設定時にエラーを返す", async () => {
    delete process.env.POSTGRES_DSN;
    const call = createCall("sql_dry_run", { query: "SELECT 1" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("POSTGRES_DSN");
  });

  it("sql_dry_run は複数ステートメントを拒否する", async () => {
    const call = createCall("sql_dry_run", { query: "SELECT 1; DELETE FROM users" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SELECT 文のみ");
  });

  it("sql_dry_run は E 文字列を含む複数ステートメントを拒否する", async () => {
    const call = createCall("sql_dry_run", { query: "SELECT E'foo\\''; DELETE FROM users" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SELECT 文のみ");
  });

  it("sql_dry_run は行末コメント付きの単一ステートメントを受け付ける", async () => {
    delete process.env.POSTGRES_DSN;
    const call = createCall("sql_dry_run", { query: "SELECT 1; -- ok" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("POSTGRES_DSN");
  });

  it("sql_dry_run はブロックコメントのみを後続に持つ入力を受け付ける", async () => {
    delete process.env.POSTGRES_DSN;
    const call = createCall("sql_dry_run", { query: "SELECT 1; /* trailing */" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("POSTGRES_DSN");
  });

  it("sql_fetch_schema は DSN 未設定時にエラーを返す", async () => {
    delete process.env.POSTGRES_DSN;
    const call = createCall("sql_fetch_schema", {});
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("POSTGRES_DSN");
  });

  it("sql_format は指定バイナリで整形できる", async () => {
    const script = path.join(tempDir, "sqruff.sh");
    const lines = [
      "#!/bin/sh",
      'if [ "$1" != "fix" ]; then exit 1; fi',
      "input=$2",
      'tmp="$input.tmp"',
      "tr '[:lower:]' '[:upper:]' < \"$input\" > \"$tmp\"",
      'mv "$tmp" "$input"',
      "exit 0",
    ];
    await fs.writeFile(script, `${lines.join("\n")}\n`, { mode: 0o755 });
    await fs.chmod(script, 0o755);
    process.env.SQRUFF_BIN = script;

    const call = createCall("sql_format", { query: "select 1;\n" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(true);
    expect(result.formatted_sql).toBe("SELECT 1;");
  });

  it("sql_format は文字列リテラル内のセミコロンを許容する", async () => {
    const script = path.join(tempDir, "sqruff-string.sh");
    const lines = ["#!/bin/sh", 'if [ "$1" != "fix" ]; then exit 1; fi', "exit 0"];
    await fs.writeFile(script, `${lines.join("\n")}\n`, { mode: 0o755 });
    await fs.chmod(script, 0o755);
    process.env.SQRUFF_BIN = script;

    const call = createCall("sql_format", { query: "SELECT 'value;test';" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(true);
    expect(result.formatted_sql).toBe("SELECT 'value;test';");
  });

  it("sql_format は行末コメントを維持して整形する", async () => {
    const script = path.join(tempDir, "sqruff-comment.sh");
    const lines = [
      "#!/bin/sh",
      'if [ "$1" != "fix" ]; then exit 1; fi',
      "input=$2",
      'temp="$input.tmp"',
      'cp "$input" "$temp"',
      'mv "$temp" "$input"',
      "exit 0",
    ];
    await fs.writeFile(script, `${lines.join("\n")}\n`, { mode: 0o755 });
    await fs.chmod(script, 0o755);
    process.env.SQRUFF_BIN = script;

    const call = createCall("sql_format", { query: "SELECT 2; -- trailing" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(true);
    expect(result.formatted_sql).toBe("SELECT 2; -- trailing");
  });

  it("sql_format は E 文字列を含む複数ステートメントを拒否する", async () => {
    const call = createCall("sql_format", { query: "SELECT E'foo\\''; DELETE FROM users" });
    const result = JSON.parse(
      await executeFunctionToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SELECT 文のみ");
  });
});
