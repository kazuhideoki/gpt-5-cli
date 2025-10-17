import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import { createBaseEnv, createTempHistoryPath, extractUserLines, runAskCli } from "../helpers/cli";

describe("CLI integration", () => {
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

  test("正常系: 単純な問い合わせが履歴に保存される", async () => {
    currentHandler = async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        await request.json();
        const body = { id: "resp-1", output_text: ["OK!"] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const env = createBaseEnv(server.port, historyPath);
    const result = await runAskCli(["正常テスト"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[gpt-5-cli]");
    expect(extractUserLines(result.stdout).at(-1)).toBe("OK!");

    expect(fs.existsSync(historyPath)).toBe(true);
    const historyRaw = fs.readFileSync(historyPath, "utf8");
    const historyData = JSON.parse(historyRaw) as Array<{
      last_response_id?: string;
      turns?: Array<{ role?: string; text?: string }>;
      request_count?: number;
      task?: { mode?: string };
    }>;
    expect(historyData.length).toBe(1);
    const [entry] = historyData;
    expect(entry.last_response_id).toBe("resp-1");
    expect(entry.request_count).toBe(1);
    expect(entry.task?.mode).toBe("ask");
    expect(entry.turns?.length).toBe(2);
    expect(entry.turns?.[0]?.role).toBe("user");
    expect(entry.turns?.[0]?.text).toBe("正常テスト");
    expect(entry.turns?.[1]?.role).toBe("assistant");
    expect(entry.turns?.[1]?.text).toBe("OK!");
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
    const result = await runAskCli(["異常テスト"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[gpt-5-cli]");
    expect(extractUserLines(result.stdout)).toHaveLength(0);
    expect(result.stderr).toContain("mock failure");
    expect(fs.existsSync(historyPath)).toBe(false);
  });

  test("--compact は他の履歴系フラグと併用できない", async () => {
    currentHandler = () =>
      new Response("unexpected request", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });

    const env = createBaseEnv(server.port, historyPath);
    const result = await runAskCli(["--compact", "1", "-c"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[gpt-5-cli]");
    expect(extractUserLines(result.stdout)).toHaveLength(0);
    expect(result.stderr).toContain("Error: --compact と他のフラグは併用できません");
  });
});
