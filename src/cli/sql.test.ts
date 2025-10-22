/**
 * @file SQL モード CLI のオプション解析と補助ロジックの単体テスト。
 */
import { describe, expect, it } from "bun:test";
import {
  buildSqlHistoryContext,
  buildSqlInstructionMessages,
  inferSqlEngineFromDsn,
  parseArgs,
} from "./sql.js";
import type { CliDefaults } from "../types.js";

const defaults: CliDefaults = {
  modelMain: "gpt-5",
  modelMini: "gpt-5-mini",
  modelNano: "gpt-5-nano",
  effort: "low",
  verbosity: "low",
  historyIndexPath: "/tmp/history.json",
  promptsDir: "/tmp/prompts",
  maxIterations: 10,
};

describe("parseArgs", () => {
  it("既定値で SQL モードとして解析する", () => {
    const options = parseArgs(["--dsn", "postgres://user:pass@host/db", "SELECT"], defaults);
    expect(options.taskMode).toBe("sql");
    expect(options.args).toEqual(["SELECT"]);
    expect(options.maxIterations).toBe(defaults.maxIterations);
    expect(options.dsn).toBe("postgres://user:pass@host/db");
    expect(options.filePath).toMatch(/^output[/\\]sql[/\\]sql-\d{8}-\d{6}-[0-9a-f]{4}\.sql$/u);
    expect(options.outputPath).toBe(options.filePath);
  });

  it("--iterations でイテレーション上限を設定できる", () => {
    const options = parseArgs(
      ["--dsn", "postgres://user:pass@host/db", "--iterations", "5", "query"],
      defaults,
    );
    expect(options.maxIterations).toBe(5);
    expect(options.maxIterationsExplicit).toBe(true);
  });

  it("--iterations へ不正な値を渡すとエラー", () => {
    expect(() =>
      parseArgs(["--dsn", "postgres://user:pass@host/db", "--iterations", "0", "prompt"], defaults),
    ).toThrow("Error: --iterations の値は 1 以上で指定してください");
  });

  it("--debug でデバッグログを有効化する", () => {
    const options = parseArgs(
      ["--dsn", "postgres://user:pass@host/db", "--debug", "SELECT"],
      defaults,
    );
    expect(options.debug).toBe(true);
  });

  it("--output で出力パスを指定できる", () => {
    const options = parseArgs(
      ["--dsn", "postgres://user:pass@host/db", "--output", "result.sql", "SELECT"],
      defaults,
    );
    expect(options.filePath).toBe("result.sql");
    expect(options.outputExplicit).toBe(true);
  });

  it("--copy でコピー出力を有効化する", () => {
    const options = parseArgs(
      ["--dsn", "postgres://user:pass@host/db", "--copy", "SELECT"],
      defaults,
    );
    expect(options.copyOutput).toBe(true);
    expect(options.copyExplicit).toBe(true);
  });

  it("--dsn を省略すると未設定のまま返す", () => {
    const options = parseArgs(["SELECT"], defaults);
    expect(options.dsn).toBeUndefined();
  });

  it("--help は --dsn なしで取得できる", () => {
    const options = parseArgs(["--help"], defaults);
    expect(options.helpRequested).toBe(true);
    expect(options.dsn).toBeUndefined();
  });
});

describe("buildSqlInstructionMessages", () => {
  it("接続情報とハッシュを含むシステムメッセージを生成する", () => {
    const messages = buildSqlInstructionMessages({
      connection: { host: "db.internal", port: 5432, database: "analytics", user: "report" },
      dsnHash: "sha256:abcd",
      maxIterations: 7,
      engine: "postgresql",
      filePath: "query.sql",
    });
    expect(messages).toHaveLength(1);
    const text = messages[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("db.internal");
    expect(text).toContain("sha256:abcd");
    expect(text).toContain("7 回");
    expect(text).toContain("PostgreSQL SELECT クエリ");
    expect(text).toContain("sql_dry_run");
    expect(text).toContain("query.sql");
    expect(text).toContain("write_file");
  });

  it("MySQL エンジン向けの文言を切り替える", () => {
    const messages = buildSqlInstructionMessages({
      connection: { host: "mysql.internal", port: 3306, database: "analytics", user: "report" },
      dsnHash: "sha256:mysql",
      maxIterations: 5,
      engine: "mysql",
      filePath: "output.sql",
    });
    expect(messages).toHaveLength(1);
    const text = messages[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("MySQL SELECT クエリ");
    expect(text).toContain("mysql.internal");
    expect(text).toContain("sha256:mysql");
    expect(text).toContain("5 回");
    expect(text).toContain("ENUM 型の定義と候補値を取得する");
    expect(text).toContain("information_schema.statistics");
    expect(text).toContain("output.sql");
  });
});

describe("buildSqlHistoryContext", () => {
  it("新しい接続情報を保存する", () => {
    const context = buildSqlHistoryContext(
      {
        dsnHash: "sha256:new",
        dsn: "postgres://report:pass@db:5432/analytics",
        connection: { host: "db", port: 5432, database: "analytics", user: "report" },
        engine: "postgresql",
      },
      undefined,
    );
    expect(context.cli).toBe("sql");
    expect(context.engine).toBe("postgresql");
    expect(context.dsn_hash).toBe("sha256:new");
    expect(context.connection?.host).toBe("db");
    expect(context.connection?.port).toBe(5432);
    expect(context.dsn).toBe("postgres://report:pass@db:5432/analytics");
  });

  it("既存のコンテキスト情報を上書きする", () => {
    const existing = {
      cli: "sql" as const,
      engine: "postgresql" as const,
      dsn_hash: "sha256:old",
      dsn: "postgres://legacy/db",
      connection: { host: "legacy" },
    };
    const updated = buildSqlHistoryContext(
      {
        dsnHash: "sha256:new",
        dsn: "postgres://next@host/db",
        connection: { host: "next", database: "analytics" },
        engine: "postgresql",
      },
      existing,
      { historyOutputFile: "result.sql", copyOutput: true },
    );
    expect(updated.dsn_hash).toBe("sha256:new");
    expect(updated.connection?.host).toBe("next");
    expect(updated.connection?.database).toBe("analytics");
    expect(updated.dsn).toBe("postgres://next@host/db");
    expect(updated.engine).toBe("postgresql");
    expect(updated.output).toEqual({ file: "result.sql", copy: true });
  });
});

describe("inferSqlEngineFromDsn", () => {
  it("PostgreSQL 系スキームを検出する", () => {
    expect(inferSqlEngineFromDsn("postgres://user@host/db")).toBe("postgresql");
    expect(inferSqlEngineFromDsn("postgresql://user@host/db")).toBe("postgresql");
    expect(inferSqlEngineFromDsn("pgsql://user@host/db")).toBe("postgresql");
  });

  it("MySQL 系スキームを検出する", () => {
    expect(inferSqlEngineFromDsn("mysql://user@host/db")).toBe("mysql");
    expect(inferSqlEngineFromDsn("mariadb://user@host/db")).toBe("mysql");
  });

  it("未対応スキームはエラーを投げる", () => {
    expect(() => inferSqlEngineFromDsn("sqlserver://host/db")).toThrow("未対応");
  });
});
