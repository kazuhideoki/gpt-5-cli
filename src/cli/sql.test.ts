/**
 * @file SQL モード CLI のオプション解析と補助ロジックの単体テスト。
 */
import { describe, expect, it } from "bun:test";
import { buildSqlCliHistoryTask, buildSqlInstructionMessages, parseArgs } from "./sql.js";
import type { CliDefaults } from "./types.js";

const defaults: CliDefaults = {
  modelMain: "gpt-5",
  modelMini: "gpt-5-mini",
  modelNano: "gpt-5-nano",
  effort: "low",
  verbosity: "low",
  historyIndexPath: "/tmp/history.json",
  promptsDir: "/tmp/prompts",
  d2MaxIterations: 8,
  sqlMaxIterations: 6,
};

describe("parseArgs", () => {
  it("既定値で SQL モードとして解析する", () => {
    const options = parseArgs(["SELECT"], defaults);
    expect(options.taskMode).toBe("sql");
    expect(options.args).toEqual(["SELECT"]);
    expect(options.sqlMaxIterations).toBe(defaults.sqlMaxIterations);
  });

  it("--sql-iterations を検証する", () => {
    const options = parseArgs(["--sql-iterations", "5", "query"], defaults);
    expect(options.sqlMaxIterations).toBe(5);
    expect(options.sqlMaxIterationsExplicit).toBe(true);
  });

  it("--sql-iterations へ不正な値を渡すとエラー", () => {
    expect(() => parseArgs(["--sql-iterations", "0", "prompt"], defaults)).toThrow("1 以上");
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
        taskModeExplicit: false,
        dsnHash: "sha256:new",
        connection: { host: "db", port: 5432, database: "analytics", user: "report" },
      },
      undefined,
    );
    expect(task?.mode).toBe("sql");
    expect(task?.sql?.dsn_hash).toBe("sha256:new");
    expect(task?.sql?.connection?.host).toBe("db");
  });

  it("既存のタスク情報を上書きする", () => {
    const existing = {
      mode: "sql",
      sql: {
        type: "postgresql" as const,
        dsn_hash: "sha256:old",
        connection: { host: "legacy" },
      },
    };
    const updated = buildSqlCliHistoryTask(
      {
        taskMode: "sql",
        taskModeExplicit: false,
        dsnHash: "sha256:new",
        connection: { host: "next", database: "analytics" },
      },
      existing,
    );
    expect(updated?.sql?.dsn_hash).toBe("sha256:new");
    expect(updated?.sql?.connection?.host).toBe("next");
    expect(updated?.sql?.connection?.database).toBe("analytics");
  });
});
