import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createBaseEnv,
  createTempHistoryPath,
  extractUserLines,
  projectRoot,
  runSqlCli,
} from "../helpers/cli";

describe("sql CLI integration", () => {
  let server: ReturnType<typeof Bun.serve>;
  let historyPath: string;
  let cleanupHistory: () => void;
  let currentHandler: ((request: Request) => Promise<Response> | Response) | null;

  beforeEach(() => {
    const temp = createTempHistoryPath();
    historyPath = temp.historyPath;
    cleanupHistory = temp.cleanup;
    currentHandler = null;
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (!currentHandler) {
          return new Response("handler not set", { status: 500 });
        }
        return currentHandler(request);
      },
    });
  });

  afterEach(() => {
    server.stop(true);
    cleanupHistory();
  });

  const testDsn = "postgres://analyst:secret@127.0.0.1:6543/analytics";
  const expectedHash = `sha256:${createHash("sha256").update(testDsn).digest("hex")}`;

  test("正常系: SQL 問い合わせが履歴に保存される", async () => {
    currentHandler = async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        await request.json();
        const body = { id: "resp-sql", output_text: ["SQL OK"] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const env = createBaseEnv(server.port, historyPath);
    const result = await runSqlCli(["--dsn", testDsn, "集計クエリを最適化して"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[gpt-5-cli-sql]");
    expect(extractUserLines(result.stdout).at(-1)).toBe("SQL OK");

    expect(fs.existsSync(historyPath)).toBe(true);
    const historyRaw = fs.readFileSync(historyPath, "utf8");
    const historyData = JSON.parse(historyRaw) as Array<{
      last_response_id?: string;
      context?: {
        cli?: string;
        engine?: string;
        dsn?: string;
        dsn_hash?: string;
        connection?: Record<string, unknown>;
        relative_path?: string;
        copy?: boolean;
        absolute_path?: string;
      };
      turns?: Array<{ role?: string; text?: string }>;
      request_count?: number;
    }>;
    expect(historyData.length).toBe(1);
    const [entry] = historyData;
    expect(entry.last_response_id).toBe("resp-sql");
    expect(entry.request_count).toBe(1);
    expect(entry.context?.cli).toBe("sql");
    expect(entry.context?.engine).toBe("postgresql");
    expect(entry.context?.dsn_hash).toBe(expectedHash);
    expect(entry.context?.dsn).toBe(testDsn);
    expect(entry.context?.connection).toEqual({
      host: "127.0.0.1",
      port: 6543,
      database: "analytics",
      user: "analyst",
    });
    expect(typeof entry.context?.relative_path).toBe("string");
    expect(entry.context?.relative_path?.endsWith(".sql")).toBe(true);
    expect(entry.turns?.length).toBe(2);
    expect(entry.turns?.[0]?.role).toBe("user");
    expect(entry.turns?.[0]?.text).toBe("集計クエリを最適化して");
    expect(entry.turns?.[1]?.role).toBe("assistant");
    expect(entry.turns?.[1]?.text).toBe("SQL OK");
  });

  test("異常系: OpenAI エラー時に非ゼロ終了し履歴を残さない", async () => {
    currentHandler = async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        await request.json();
        const body = { error: { message: "mock failure" } };
        return new Response(JSON.stringify(body), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const env = createBaseEnv(server.port, historyPath);
    const result = await runSqlCli(["--dsn", testDsn, "失敗テスト"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[gpt-5-cli-sql]");
    expect(extractUserLines(result.stdout)).toHaveLength(0);
    expect(result.stderr).toContain("mock failure");
    expect(fs.existsSync(historyPath)).toBe(false);
  });

  test("SQL モード: DSN ハッシュと接続情報が継続時も保持される", async () => {
    const responses = [
      { id: "resp-sql-1", text: "SQL OK (1)" },
      { id: "resp-sql-2", text: "SQL OK (2)" },
      { id: "resp-sql-3", text: "SQL OK (3)" },
      { id: "resp-sql-summary", text: "SQL Summary" },
    ];
    let callIndex = 0;

    currentHandler = async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        await request.json();
        if (callIndex >= responses.length) {
          return new Response("unexpected request", { status: 500 });
        }
        const payload = responses[callIndex];
        callIndex += 1;
        return new Response(JSON.stringify({ id: payload.id, output_text: [payload.text] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const env = createBaseEnv(server.port, historyPath);

    const first = await runSqlCli(["--dsn", testDsn, "初回SQL"], env);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("[gpt-5-cli-sql]");
    expect(extractUserLines(first.stdout).at(-1)).toBe("SQL OK (1)");

    expect(fs.existsSync(historyPath)).toBe(true);
    const historyAfterFirst = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterFirst.length).toBe(1);
    const firstEntry = historyAfterFirst[0];
    expect(firstEntry.context?.dsn_hash).toBe(expectedHash);
    expect(firstEntry.context?.connection).toEqual({
      host: "127.0.0.1",
      port: 6543,
      database: "analytics",
      user: "analyst",
    });
    expect(firstEntry.request_count).toBe(1);
    expect(firstEntry.context?.relative_path?.endsWith(".sql")).toBe(true);

    const second = await runSqlCli(["-c", "2回目"], env);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("[gpt-5-cli-sql]");
    expect(extractUserLines(second.stdout).at(-1)).toBe("SQL OK (2)");

    const historyAfterSecond = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterSecond.length).toBe(1);
    const secondEntry = historyAfterSecond[0];
    expect(secondEntry.request_count).toBe(2);
    expect(secondEntry.context?.dsn_hash).toBe(expectedHash);
    expect(secondEntry.context?.dsn).toBe(testDsn);
    expect(secondEntry.context?.relative_path?.endsWith(".sql")).toBe(true);

    const third = await runSqlCli(["-c", "3回目"], env);
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toContain("[gpt-5-cli-sql]");
    expect(extractUserLines(third.stdout).at(-1)).toBe("SQL OK (3)");

    const historyAfterThird = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterThird.length).toBe(1);
    const thirdEntry = historyAfterThird[0];
    expect(thirdEntry.request_count).toBe(3);
    expect(thirdEntry.context?.dsn_hash).toBe(expectedHash);
    expect(thirdEntry.context?.dsn).toBe(testDsn);
    expect(thirdEntry.context?.relative_path?.endsWith(".sql")).toBe(true);

    const summary = await runSqlCli(["--compact", "1"], env);
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain("[gpt-5-cli-sql] compact: history=1");
    expect(extractUserLines(summary.stdout).at(-1)).toBe("SQL Summary");

    const historyAfterSummary = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterSummary.length).toBe(1);
    const summaryEntry = historyAfterSummary[0];
    expect(summaryEntry.context?.dsn_hash).toBe(expectedHash);
    expect(summaryEntry.context?.dsn).toBe(testDsn);
    expect(summaryEntry.turns?.length).toBe(1);
    expect(summaryEntry.turns?.[0]?.role).toBe("system");
    expect(summaryEntry.turns?.[0]?.text).toBe("SQL Summary");
    expect(summaryEntry.resume?.summary?.text).toBe("SQL Summary");
    expect(summaryEntry.context?.relative_path?.endsWith(".sql")).toBe(true);
    expect(callIndex).toBe(responses.length);
  });

  test("既存の SQL ファイルを最終応答で上書きしない", async () => {
    currentHandler = async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        await request.json();
        const body = { id: "resp-sql", output_text: ["SQL OK"] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const env = createBaseEnv(server.port, historyPath);
    const uniqueDir = path.join("tmp", "sql-tests", randomUUID());
    const relativePath = path.join(uniqueDir, "query.sql");
    const absolutePath = path.resolve(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const sentinel = "select 1;\n";
    fs.writeFileSync(absolutePath, sentinel, "utf8");

    const result = await runSqlCli(
      ["--dsn", testDsn, "-o", relativePath, "既存ファイルテスト"],
      env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[gpt-5-cli-sql]");
    expect(extractUserLines(result.stdout).at(-1)).toBe("SQL OK");

    const persisted = fs.readFileSync(absolutePath, "utf8");
    expect(persisted).toBe(sentinel);

    fs.rmSync(path.dirname(absolutePath), { recursive: true, force: true });
  });
});
