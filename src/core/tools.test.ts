import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  D2_CHECK_TOOL,
  D2_FMT_TOOL,
  MERMAID_CHECK_TOOL,
  READ_FILE_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FETCH_COLUMN_SCHEMA_TOOL,
  SQL_FETCH_ENUM_SCHEMA_TOOL,
  SQL_FETCH_INDEX_SCHEMA_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  SQL_FORMAT_TOOL,
  WRITE_FILE_TOOL,
  buildAgentsToolList,
  createToolRuntime,
  setSqlEnvironment,
  resolveMermaidCommand,
  resolveWorkspacePath,
  type ToolRegistration,
  type ToolResult,
} from "./tools.js";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";
import { Client } from "pg";
import mysql from "mysql2/promise";
import type { Connection as MysqlConnection } from "mysql2/promise";

function createCall(name: string, args: Record<string, unknown>): ResponseFunctionToolCall {
  return {
    type: "function_call",
    id: `call-${name}`,
    call_id: `call-${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

const MINIMAL_TOOLSET = [READ_FILE_TOOL] as const;
const D2_TOOLSET = [READ_FILE_TOOL, WRITE_FILE_TOOL, D2_CHECK_TOOL, D2_FMT_TOOL] as const;
const MERMAID_TOOLSET = [READ_FILE_TOOL, WRITE_FILE_TOOL, MERMAID_CHECK_TOOL] as const;
const SQL_TOOLSET = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  SQL_FETCH_TABLE_SCHEMA_TOOL,
  SQL_FETCH_COLUMN_SCHEMA_TOOL,
  SQL_FETCH_ENUM_SCHEMA_TOOL,
  SQL_FETCH_INDEX_SCHEMA_TOOL,
  SQL_DRY_RUN_TOOL,
  SQL_FORMAT_TOOL,
] as const;

const { tools: MINIMAL_FUNCTION_TOOLS } = createToolRuntime(MINIMAL_TOOLSET);
const { tools: D2_FUNCTION_TOOLS, execute: executeD2ToolCall } = createToolRuntime(D2_TOOLSET);
const { tools: MERMAID_FUNCTION_TOOLS } = createToolRuntime(MERMAID_TOOLSET);
const { tools: SQL_FUNCTION_TOOLS, execute: executeSqlToolCall } = createToolRuntime(SQL_TOOLSET);

const ORIGINAL_SQRUFF_BIN = process.env.SQRUFF_BIN;
const ORIGINAL_MYSQL_CREATE_CONNECTION = mysql.createConnection;

afterEach(() => {
  if (ORIGINAL_SQRUFF_BIN === undefined) {
    delete process.env.SQRUFF_BIN;
  } else {
    process.env.SQRUFF_BIN = ORIGINAL_SQRUFF_BIN;
  }

  mysql.createConnection = ORIGINAL_MYSQL_CREATE_CONNECTION;
  setSqlEnvironment(undefined);
});

describe("tool registration lists", () => {
  it("最小構成は read_file のみを公開する", () => {
    const toolNames = MINIMAL_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual(["read_file"]);
  });

  it("最小構成には SQL 系ツールが含まれない", () => {
    const toolNames = MINIMAL_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).not.toContain("sql_fetch_table_schema");
    expect(toolNames).not.toContain("sql_fetch_column_schema");
    expect(toolNames).not.toContain("sql_fetch_enum_schema");
    expect(toolNames).not.toContain("sql_fetch_index_schema");
    expect(toolNames).not.toContain("sql_dry_run");
    expect(toolNames).not.toContain("sql_format");
  });

  it("SQL 向け拡張セットを構築できる", () => {
    const toolNames = SQL_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual([
      "read_file",
      "write_file",
      "sql_fetch_table_schema",
      "sql_fetch_column_schema",
      "sql_fetch_enum_schema",
      "sql_fetch_index_schema",
      "sql_dry_run",
      "sql_format",
    ]);
  });

  it("ワークスペース操作向け拡張セットを構築できる", () => {
    const toolNames = D2_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual(["read_file", "write_file", "d2_check", "d2_fmt"]);
  });

  it("Mermaid 向けツールセットを構築できる", () => {
    const toolNames = MERMAID_FUNCTION_TOOLS.map((tool) => tool.name);
    expect(toolNames).toEqual(["read_file", "write_file", "mermaid_check"]);
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
    setSqlEnvironment({ dsn: "postgres://example.invalid/db", engine: "postgresql" });
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
      await executeD2ToolCall(writeCall, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(writeResult.success).toBe(true);
    expect(writeResult.path).toBe("diagram.d2");

    const readCall = createCall("read_file", { path: "diagram.d2" });
    const readResult = JSON.parse(
      await executeD2ToolCall(readCall, {
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
      await executeD2ToolCall(readCall, {
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
      await executeD2ToolCall(call, {
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

    const { tools, execute } = createToolRuntime([...D2_TOOLSET, extraTool]);
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
      await executeSqlToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SELECT");
  });

  it("sql_dry_run は DSN 未設定時にエラーを返す", async () => {
    setSqlEnvironment(undefined);
    const call = createCall("sql_dry_run", { query: "SELECT 1" });
    const result = JSON.parse(
      await executeSqlToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SQL environment is not configured");
  });

  it("sql_dry_run は複数ステートメントを拒否する", async () => {
    const call = createCall("sql_dry_run", { query: "SELECT 1; DELETE FROM users" });
    const result = JSON.parse(
      await executeSqlToolCall(call, {
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
      await executeSqlToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SELECT 文のみ");
  });

  it("sql_dry_run は行末コメント付きの単一ステートメントを受け付ける", async () => {
    setSqlEnvironment(undefined);
    const call = createCall("sql_dry_run", { query: "SELECT 1; -- ok" });
    const result = JSON.parse(
      await executeSqlToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SQL environment is not configured");
  });

  it("sql_dry_run はブロックコメントのみを後続に持つ入力を受け付ける", async () => {
    setSqlEnvironment(undefined);
    const call = createCall("sql_dry_run", { query: "SELECT 1; /* trailing */" });
    const result = JSON.parse(
      await executeSqlToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SQL environment is not configured");
  });

  it("SQL スキーマ系ツールは DSN 未設定時にエラーを返す", async () => {
    setSqlEnvironment(undefined);
    const calls = [
      createCall("sql_fetch_table_schema", {}),
      createCall("sql_fetch_column_schema", {}),
      createCall("sql_fetch_enum_schema", {}),
      createCall("sql_fetch_index_schema", {}),
    ];
    for (const call of calls) {
      const result = JSON.parse(
        await executeSqlToolCall(call, {
          cwd: tempDir,
          log: () => {},
        }),
      );
      expect(result.success).toBe(false);
      expect(String(result.message)).toContain("SQL environment is not configured");
    }
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
      await executeSqlToolCall(call, {
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
      await executeSqlToolCall(call, {
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
      await executeSqlToolCall(call, {
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
      await executeSqlToolCall(call, {
        cwd: tempDir,
        log: () => {},
      }),
    );
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("SELECT 文のみ");
  });
});

describe("SQL schema fetch tool queries", () => {
  type QueryCall = { text: string; values: unknown[] | undefined };

  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;

  let queryCalls: QueryCall[];
  let connectCount: number;
  let endCount: number;

  beforeEach(() => {
    setSqlEnvironment({ dsn: "postgres://example.invalid/db", engine: "postgresql" });
    queryCalls = [];
    connectCount = 0;
    endCount = 0;

    Client.prototype.connect = async function mockConnect() {
      connectCount += 1;
    };
    Client.prototype.query = async function mockQuery(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: unknown[] }> {
      queryCalls.push({ text, values });
      return { rows: [] };
    };
    Client.prototype.end = async function mockEnd() {
      endCount += 1;
    };
  });

  afterEach(() => {
    Client.prototype.connect = originalConnect;
    Client.prototype.query = originalQuery;
    Client.prototype.end = originalEnd;
  });

  const context = {
    cwd: process.cwd(),
    log: () => {},
  };

  it("sql_fetch_table_schema は指定フィルタをクエリへ反映する", async () => {
    const result = await SQL_FETCH_TABLE_SCHEMA_TOOL.handler(
      {
        schema_names: ["public", " sales "],
        table_names: ["reservations"],
        table_types: ["base table"],
      },
      context,
    );
    expect(result.success).toBe(true);
    expect(connectCount).toBe(1);
    expect(endCount).toBe(1);
    expect(queryCalls).toHaveLength(1);
    const [call] = queryCalls;
    expect(call.text).toMatch(/table_schema\s*NOT IN/u);
    expect(call.text).toMatch(/table_schema\s*=\s*ANY\(\$1::text\[\]\)/u);
    expect(call.text).toMatch(/table_name\s*=\s*ANY\(\$2::text\[\]\)/u);
    expect(call.text).toMatch(/table_type\s*=\s*ANY\(\$3::text\[\]\)/u);
    expect(call.values).toEqual([["public", "sales"], ["reservations"], ["BASE TABLE"]]);
  });

  it("sql_fetch_column_schema は列フィルタをクエリへ反映する", async () => {
    await SQL_FETCH_COLUMN_SCHEMA_TOOL.handler(
      {
        schema_names: ["public"],
        table_names: ["reservations"],
        column_names: [" user_id ", "created_at"],
      },
      context,
    );
    expect(queryCalls).toHaveLength(1);
    const [call] = queryCalls;
    expect(call.text).toMatch(/column_name\s*=\s*ANY\(\$3::text\[\]\)/u);
    expect(call.values).toEqual([["public"], ["reservations"], ["user_id", "created_at"]]);
  });

  it("sql_fetch_column_schema は tables で複数テーブルの列を取得できる", async () => {
    await SQL_FETCH_COLUMN_SCHEMA_TOOL.handler(
      {
        tables: [
          { schema_name: "public", table_name: "reservations" },
          { schema_name: "sales", table_name: "orders" },
        ],
      },
      context,
    );
    expect(queryCalls).toHaveLength(1);
    const [call] = queryCalls;
    expect(call.text).toMatch(/\(table_schema = \$1 AND table_name = \$2\)/u);
    expect(call.text).toMatch(/\(table_schema = \$3 AND table_name = \$4\)/u);
    expect(call.text).toMatch(
      /\((?:table_schema = \$1 AND table_name = \$2).*OR.*(table_schema = \$3 AND table_name = \$4)\)/u,
    );
    expect(call.values).toEqual(["public", "reservations", "sales", "orders"]);
  });

  it("sql_fetch_enum_schema はスキーマと enum 名をフィルタする", async () => {
    await SQL_FETCH_ENUM_SCHEMA_TOOL.handler(
      {
        schema_names: ["types"],
        enum_names: ["reservation_status"],
      },
      context,
    );
    expect(queryCalls).toHaveLength(1);
    const [call] = queryCalls;
    expect(call.text).toMatch(/n\.nspname\s*=\s*ANY\(\$1::text\[\]\)/u);
    expect(call.text).toMatch(/t\.typname\s*=\s*ANY\(\$2::text\[\]\)/u);
    expect(call.values).toEqual([["types"], ["reservation_status"]]);
  });

  it("sql_fetch_index_schema はインデックスフィルタをクエリへ反映する", async () => {
    await SQL_FETCH_INDEX_SCHEMA_TOOL.handler(
      {
        schema_names: ["public"],
        table_names: ["reservations"],
        index_names: ["reservations_user_idx"],
      },
      context,
    );
    expect(queryCalls).toHaveLength(1);
    const [call] = queryCalls;
    expect(call.text).toMatch(/schemaname\s*=\s*ANY\(\$1::text\[\]\)/u);
    expect(call.text).toMatch(/tablename\s*=\s*ANY\(\$2::text\[\]\)/u);
    expect(call.text).toMatch(/indexname\s*=\s*ANY\(\$3::text\[\]\)/u);
    expect(call.values).toEqual([["public"], ["reservations"], ["reservations_user_idx"]]);
  });
});

describe("SQL schema fetch tool queries (MySQL)", () => {
  class MockMysqlConnection {
    public executeCalls: Array<{ sql: string; values?: unknown[] }>; // parameters passed to execute
    public queryCalls: Array<{ sql: string; values?: unknown[] }>;
    public ended: boolean;
    public executeImpl: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
    public queryImpl: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;

    constructor() {
      this.executeCalls = [];
      this.queryCalls = [];
      this.ended = false;
      this.executeImpl = async () => [[], []];
      this.queryImpl = async () => [[], []];
    }

    async execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]> {
      this.executeCalls.push({ sql, values: Array.isArray(values) ? values : undefined });
      return this.executeImpl(sql, values);
    }

    async query(sql: string, values?: unknown[]): Promise<[unknown, unknown]> {
      this.queryCalls.push({ sql, values: Array.isArray(values) ? values : undefined });
      return this.queryImpl(sql, values);
    }

    async end(): Promise<void> {
      this.ended = true;
    }
  }

  const context = {
    cwd: process.cwd(),
    log: () => {},
  };

  let connection: MockMysqlConnection;
  let createCalls: number;

  beforeEach(() => {
    setSqlEnvironment({ dsn: "mysql://example.invalid/test", engine: "mysql" });
    connection = new MockMysqlConnection();
    createCalls = 0;
    mysql.createConnection = (async () => {
      createCalls += 1;
      return connection as unknown as MysqlConnection;
    }) as typeof mysql.createConnection;
  });

  afterEach(() => {
    mysql.createConnection = ORIGINAL_MYSQL_CREATE_CONNECTION;
  });

  it("sql_fetch_table_schema は MySQL の information_schema を参照する", async () => {
    connection.executeImpl = async () => [
      [
        {
          table_schema: "app",
          table_name: "orders",
          table_type: "BASE TABLE",
          is_insertable_into: "YES",
        },
      ],
      [],
    ];

    const result = await SQL_FETCH_TABLE_SCHEMA_TOOL.handler(
      {
        schema_names: ["app"],
        table_types: ["base table"],
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(createCalls).toBe(1);
    expect(connection.executeCalls[0]?.sql).toContain("information_schema.tables");
    expect(connection.executeCalls[0]?.values?.[0]).toEqual(["app"]);
    expect(connection.ended).toBe(true);
  });

  it("sql_fetch_column_schema は MySQL でもフィルタを適用する", async () => {
    connection.executeImpl = async () => [
      [
        {
          table_schema: "app",
          table_name: "orders",
          column_name: "status",
          data_type: "enum",
          is_nullable: "NO",
          column_default: "pending",
        },
      ],
      [],
    ];

    const result = await SQL_FETCH_COLUMN_SCHEMA_TOOL.handler(
      {
        schema_names: ["app"],
        table_names: ["orders"],
        column_names: ["status"],
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(connection.executeCalls[0]?.sql).toContain("information_schema.columns");
    expect(connection.executeCalls[0]?.values?.[0]).toEqual(["app"]);
    expect(connection.ended).toBe(true);
  });

  it("sql_fetch_enum_schema は ENUM 値を展開する", async () => {
    connection.executeImpl = async () => [
      [
        {
          table_schema: "app",
          table_name: "orders",
          column_name: "status",
          column_type: "enum('draft','published','archived')",
        },
      ],
      [],
    ];

    const result = (await SQL_FETCH_ENUM_SCHEMA_TOOL.handler({}, context)) as ToolResult & {
      rows?: Array<{ enum_label: string; enum_name: string; sort_order: number }>;
      row_count?: number;
    };

    expect(result.success).toBe(true);
    expect(result.row_count).toBe(3);
    expect(result.rows?.map((row) => row.enum_label)).toEqual(["draft", "published", "archived"]);
    expect(result.rows?.every((row) => row.enum_name === "orders.status")).toBe(true);
    expect(connection.ended).toBe(true);
  });

  it("sql_fetch_enum_schema は table.column 形式のフィルタを解釈する", async () => {
    connection.executeImpl = async () => [
      [
        {
          table_schema: "app",
          table_name: "orders",
          column_name: "status",
          column_type: "enum('draft','published')",
        },
      ],
      [],
    ];

    const result = (await SQL_FETCH_ENUM_SCHEMA_TOOL.handler(
      {
        enum_names: ["orders.status"],
      },
      context,
    )) as ToolResult & {
      rows?: Array<{ enum_label: string; enum_name: string }>;
      row_count?: number;
    };

    expect(result.success).toBe(true);
    expect(result.row_count).toBe(2);
    expect(connection.executeCalls[0]?.values).toEqual(["orders", "status"]);
    expect(result.rows?.map((row) => row.enum_label)).toEqual(["draft", "published"]);
  });

  it("sql_fetch_index_schema は statistics から定義を生成する", async () => {
    connection.executeImpl = async () => [
      [
        {
          table_schema: "app",
          table_name: "orders",
          index_name: "PRIMARY",
          index_definition: "PRIMARY KEY (id)",
        },
      ],
      [],
    ];

    const result = await SQL_FETCH_INDEX_SCHEMA_TOOL.handler({}, context);

    expect(result.success).toBe(true);
    expect(connection.executeCalls[0]?.sql).toContain("information_schema.statistics");
    expect(
      (result as ToolResult & { rows?: Array<{ index_definition?: string }> }).rows?.[0]
        ?.index_definition,
    ).toBe("PRIMARY KEY (id)");
    expect(connection.ended).toBe(true);
  });

  it("sql_dry_run は MySQL の EXPLAIN FORMAT=JSON を実行する", async () => {
    connection.queryImpl = async (sql) => {
      if (typeof sql === "string" && sql.startsWith("EXPLAIN")) {
        return [[{ EXPLAIN: { plan: "ok" } }], []];
      }
      return [[], []];
    };

    const call = createCall("sql_dry_run", { query: "SELECT 1" });
    const result = JSON.parse(
      await executeSqlToolCall(call, {
        cwd: context.cwd,
        log: context.log,
      }),
    ) as ToolResult & { plan?: unknown };

    expect(result.success).toBe(true);
    expect(result.plan).toEqual({ plan: "ok" });
    expect(connection.queryCalls[0]?.sql).toContain("EXPLAIN FORMAT=JSON");
    expect(connection.ended).toBe(true);
  });
});

describe("buildAgentsToolList", () => {
  it("Agents SDK のツール定義へ変換し、ハンドラ実行結果を文字列で返す", async () => {
    const logs: string[] = [];
    const debugLogs: string[] = [];
    const registration: ToolRegistration<{ path: string }, ToolResult> = {
      definition: {
        type: "function",
        strict: true,
        name: "sample_tool",
        description: "Emit the provided path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      handler: async (args): Promise<ToolResult> => ({
        success: true,
        path: args.path,
      }),
    };

    const [agentTool] = buildAgentsToolList([registration], {
      logLabel: "[agent-test]",
      createExecutionContext: () => ({
        cwd: "/workspace",
        log: (message: string) => {
          logs.push(message);
        },
      }),
      debugLog: (message: string) => {
        debugLogs.push(message);
      },
    });

    const result = await (agentTool as any).invoke(
      undefined,
      JSON.stringify({ path: "diagram.d2" }),
      {
        toolCall: { call_id: "call-1", id: "call-1" },
      },
    );

    expect(JSON.parse(result)).toEqual({ success: true, path: "diagram.d2" });
    expect(logs).toContain("tool handling sample_tool (call-1)");
    expect(debugLogs.some((entry) => entry.includes("arguments"))).toBe(true);
    expect(debugLogs.some((entry) => entry.includes("output"))).toBe(true);
  });

  it("ハンドラが例外を投げた場合に失敗レスポンスを返す", async () => {
    const registration: ToolRegistration = {
      definition: {
        type: "function",
        strict: true,
        name: "exploding_tool",
        description: "Always throw.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      handler: async () => {
        throw new Error("boom");
      },
    };

    const [agentTool] = buildAgentsToolList([registration]);
    const result = await (agentTool as any).invoke(undefined, "{}", {
      toolCall: { call_id: "call-9", id: "call-9" },
    });

    expect(JSON.parse(result)).toEqual({ success: false, message: "boom" });
  });
});

describe("resolveMermaidCommand", () => {
  it("CLI 同梱の Mermaid CLI を Node 経由で実行する", async () => {
    const { command, args } = await resolveMermaidCommand();
    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    const scriptPath = args[0]!;
    expect(path.isAbsolute(scriptPath)).toBe(true);
    expect(scriptPath).toMatch(/@mermaid-js[/\\]mermaid-cli/);
    const stat = await fs.stat(scriptPath);
    expect(stat.isFile()).toBe(true);
  });
});
