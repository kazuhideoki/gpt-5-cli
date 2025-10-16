/**
 * @file SQL モード CLI のオプション解析と補助ロジックの単体テスト。
 */
import { describe, expect, it } from "bun:test";
import { buildSqlCliHistoryTask, buildSqlInstructionMessages, parseArgs } from "./sql.js";
import type { CliDefaults } from "../core/types.js";

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
  });

  it("--sql-iterations を検証する", () => {
    const options = parseArgs(
      ["--dsn", "postgres://user:pass@host/db", "--sql-iterations", "5", "query"],
      defaults,
    );
    expect(options.maxIterations).toBe(5);
    expect(options.maxIterationsExplicit).toBe(true);
  });

  it("--sql-iterations へ不正な値を渡すとエラー", () => {
    expect(() =>
      parseArgs(
        ["--dsn", "postgres://user:pass@host/db", "--sql-iterations", "0", "prompt"],
        defaults,
      ),
    ).toThrow("1 以上");
  });

  it("--debug でデバッグログを有効化する", () => {
    const options = parseArgs(
      ["--dsn", "postgres://user:pass@host/db", "--debug", "SELECT"],
      defaults,
    );
    expect(options.debug).toBe(true);
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
    });
    expect(messages).toHaveLength(1);
    const text = messages[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("db.internal");
    expect(text).toContain("sha256:abcd");
    expect(text).toContain("7 回");
    expect(text).toContain("sql_dry_run");
  });
});

describe("buildSqlCliHistoryTask", () => {
  it("新しい接続情報を保存する", () => {
    const task = buildSqlCliHistoryTask(
      {
        taskMode: "sql",
        dsnHash: "sha256:new",
        dsn: "postgres://report:pass@db:5432/analytics",
        connection: { host: "db", port: 5432, database: "analytics", user: "report" },
      },
      undefined,
    );
    expect(task?.mode).toBe("sql");
    expect(task?.sql?.dsn_hash).toBe("sha256:new");
    expect(task?.sql?.connection?.host).toBe("db");
    expect(task?.sql?.dsn).toBe("postgres://report:pass@db:5432/analytics");
  });

  it("既存のタスク情報を上書きする", () => {
    const existing = {
      mode: "sql",
      sql: {
        type: "postgresql" as const,
        dsn_hash: "sha256:old",
        dsn: "postgres://legacy/db",
        connection: { host: "legacy" },
      },
    };
    const updated = buildSqlCliHistoryTask(
      {
        taskMode: "sql",
        dsnHash: "sha256:new",
        dsn: "postgres://next@host/db",
        connection: { host: "next", database: "analytics" },
      },
      existing,
    );
    expect(updated?.sql?.dsn_hash).toBe("sha256:new");
    expect(updated?.sql?.connection?.host).toBe("next");
    expect(updated?.sql?.connection?.database).toBe("analytics");
    expect(updated?.sql?.dsn).toBe("postgres://next@host/db");
  });
});
