/**
 * @file SQL モード CLI のオプション解析と補助ロジックの単体テスト。
 */
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  buildSqlHistoryContext,
  buildSqlInstructionMessages,
  ensureSqlContext,
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
    expect(options.artifactPath).toMatch(/^output[/\\]sql[/\\]sql-\d{8}-\d{6}-[0-9a-f]{4}\.sql$/u);
    // TODO 履歴保存と成果物保存が一緒になり得るという、混乱する仕様。要修正
    expect(options.responseOutputPath).toBe(options.artifactPath);
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
    expect(options.artifactPath).toBe("result.sql");
    expect(options.responseOutputExplicit).toBe(true);
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
      artifactPath: "query.sql",
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
      artifactPath: "output.sql",
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
      { historyArtifactPath: "result.sql", copyOutput: true },
    );
    expect(updated.dsn_hash).toBe("sha256:new");
    expect(updated.connection?.host).toBe("next");
    expect(updated.connection?.database).toBe("analytics");
    expect(updated.dsn).toBe("postgres://next@host/db");
    expect(updated.engine).toBe("postgresql");
    expect(updated.relative_path).toBe("result.sql");
    expect(updated.copy).toBe(true);
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

describe("ensureSqlContext", () => {
  const tempEntries: string[] = [];

  afterEach(() => {
    for (const entry of tempEntries.splice(0)) {
      fs.rmSync(entry, { recursive: true, force: true });
    }
  });

  const testDsn = "postgres://user:pass@localhost:5432/db";

  it("ワークスペース内のパスを正規化し、存在しない場合は exists=false を返す", () => {
    const relativeDir = path.join("tmp", "sql-context", randomUUID());
    const absoluteDir = path.resolve(process.cwd(), relativeDir);
    fs.mkdirSync(absoluteDir, { recursive: true });
    tempEntries.push(absoluteDir);

    const relativePath = path.join(relativeDir, "query.sql");
    const options = parseArgs(["--dsn", testDsn, "--output", relativePath, "SELECT"], defaults);

    const snapshot = { ...options };
    const result = ensureSqlContext(options);

    expect(result.context.relativePath).toBe(relativePath);
    expect(result.context.absolutePath).toBe(path.resolve(process.cwd(), relativePath));
    expect(result.context.exists).toBe(false);
    expect(result.normalizedOptions.artifactPath).toBe(relativePath);
    expect(result.normalizedOptions.responseOutputPath).toBe(relativePath);
    expect(options).toEqual(snapshot);
  });

  it("既存ファイルがある場合は exists=true を返す", () => {
    const relativeDir = path.join("tmp", "sql-context", randomUUID());
    const absoluteDir = path.resolve(process.cwd(), relativeDir);
    fs.mkdirSync(absoluteDir, { recursive: true });
    tempEntries.push(absoluteDir);

    const relativePath = path.join(relativeDir, "query.sql");
    const absolutePath = path.resolve(process.cwd(), relativePath);
    fs.writeFileSync(absolutePath, "SELECT 1;");

    const options = parseArgs(["--dsn", testDsn, "--output", relativePath, "SELECT"], defaults);
    const snapshot = { ...options };
    const result = ensureSqlContext(options);

    expect(result.context.relativePath).toBe(relativePath);
    expect(result.context.absolutePath).toBe(absolutePath);
    expect(result.context.exists).toBe(true);
    expect(result.normalizedOptions.artifactPath).toBe(relativePath);
    expect(result.normalizedOptions.responseOutputPath).toBe(relativePath);
    expect(options).toEqual(snapshot);
  });

  it("ワークスペース外のパスではエラーを投げる", () => {
    const outsidePath = path.resolve(process.cwd(), "..", `outside-${randomUUID()}.sql`);
    const options = parseArgs(["--dsn", testDsn, "--output", outsidePath, "SELECT"], defaults);

    expect(() => ensureSqlContext(options)).toThrow(
      `Error: SQL出力の保存先はカレントディレクトリ配下に指定してください: ${outsidePath}`,
    );
  });

  it("既存ディレクトリを指す場合はエラーを投げる", () => {
    const relativeDir = path.join("tmp", "sql-context", randomUUID());
    const absoluteDir = path.resolve(process.cwd(), relativeDir);
    fs.mkdirSync(absoluteDir, { recursive: true });
    tempEntries.push(absoluteDir);

    const options = parseArgs(["--dsn", testDsn, "--output", relativeDir, "SELECT"], defaults);
    expect(() => ensureSqlContext(options)).toThrow(
      `Error: 指定した SQL ファイルパスはディレクトリです: ${relativeDir}`,
    );
  });

  it("正規化済みオプションを返す", () => {
    const options = parseArgs(["--dsn", testDsn, "--output", "./result.sql", "SELECT"], defaults);
    const snapshot = { ...options };

    const result = ensureSqlContext(options);

    expect(result.normalizedOptions).not.toBe(options);
    expect(result.normalizedOptions.artifactPath).toBe("result.sql");
    expect(result.normalizedOptions.responseOutputPath).toBe("result.sql");
    expect(options).toEqual(snapshot);
  });

  it("入力オプションを変異せず context を構築する", () => {
    const options = parseArgs(["--dsn", testDsn, "--output", "./result.sql", "SELECT"], defaults);

    const result = ensureSqlContext(options);

    expect(result.context.relativePath).toBe("result.sql");
    expect(result.context.absolutePath).toBe(path.resolve(process.cwd(), "result.sql"));
    expect(result.context.exists).toBe(false);
    expect(options.artifactPath).toBe("./result.sql");
    expect(options.responseOutputPath).toBe("./result.sql");
  });
});
