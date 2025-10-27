import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createBaseEnv,
  createTempHistoryPath,
  extractUserLines,
  projectRoot,
  runMermaidCli,
} from "../helpers/cli";

describe("mermaid CLI integration", () => {
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

  test("正常系: Mermaid 問い合わせが履歴に保存される", async () => {
    currentHandler = async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        await request.json();
        const body = { id: "resp-mermaid", output_text: ["Mermaid OK"] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const env = createBaseEnv(server.port, historyPath);
    const relativePath = path.join("diagrams", "flow.mmd");
    const expectedAbsolutePath = path.resolve(projectRoot, relativePath);
    const result = await runMermaidCli(["-o", relativePath, "Mermaid 図を作成"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[gpt-5-cli-mermaid]");
    expect(extractUserLines(result.stdout).at(-1)).toBe("Mermaid OK");

    expect(fs.existsSync(historyPath)).toBe(true);
    const historyRaw = fs.readFileSync(historyPath, "utf8");
    const historyData = JSON.parse(historyRaw) as Array<{
      last_response_id?: string;
      context?: { cli?: string; absolute_path?: string; relative_path?: string; copy?: boolean };
      turns?: Array<{ role?: string; text?: string }>;
      request_count?: number;
    }>;
    expect(historyData.length).toBe(1);
    const [entry] = historyData;
    expect(entry.last_response_id).toBe("resp-mermaid");
    expect(entry.request_count).toBe(1);
    expect(entry.context?.cli).toBe("mermaid");
    expect(entry.context?.absolute_path).toBe(expectedAbsolutePath);
    expect(entry.context?.relative_path).toBe(relativePath);
    expect(entry.turns?.length).toBe(2);
    expect(entry.turns?.[0]?.role).toBe("user");
    expect(entry.turns?.[0]?.text).toBe("Mermaid 図を作成");
    expect(entry.turns?.[1]?.role).toBe("assistant");
    expect(entry.turns?.[1]?.text).toBe("Mermaid OK");
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
    const result = await runMermaidCli(["失敗テスト"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[gpt-5-cli-mermaid]");
    expect(extractUserLines(result.stdout)).toHaveLength(0);
    expect(result.stderr).toContain("mock failure");
    expect(fs.existsSync(historyPath)).toBe(false);
  });

  test("Mermaid モード: 履歴に絶対パスを保持し継続時も固定される", async () => {
    const responses = [
      { id: "resp-mermaid-1", text: "Mermaid OK (1)" },
      { id: "resp-mermaid-2", text: "Mermaid OK (2)" },
      { id: "resp-mermaid-3", text: "Mermaid OK (3)" },
      { id: "resp-mermaid-summary", text: "Mermaid Summary" },
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
    const relativePath = path.join("diagrams", "flowchart.mmd");
    const expectedAbsolutePath = path.resolve(projectRoot, relativePath);

    const first = await runMermaidCli(["-o", relativePath, "初回Mermaid"], env);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("[gpt-5-cli-mermaid]");
    expect(extractUserLines(first.stdout).at(-1)).toBe("Mermaid OK (1)");

    expect(fs.existsSync(historyPath)).toBe(true);
    const historyAfterFirst = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterFirst.length).toBe(1);
    const firstEntry = historyAfterFirst[0];
    expect(firstEntry.context?.cli).toBe("mermaid");
    expect(firstEntry.context?.absolute_path).toBe(expectedAbsolutePath);
    expect(firstEntry.context?.relative_path).toBe(relativePath);
    expect(firstEntry.request_count).toBe(1);

    const second = await runMermaidCli(["-c", "2回目"], env);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("[gpt-5-cli-mermaid]");
    expect(extractUserLines(second.stdout).at(-1)).toBe("Mermaid OK (2)");

    const historyAfterSecond = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterSecond.length).toBe(1);
    const secondEntry = historyAfterSecond[0];
    expect(secondEntry.context?.cli).toBe("mermaid");
    expect(secondEntry.request_count).toBe(2);
    expect(secondEntry.context?.absolute_path).toBe(expectedAbsolutePath);
    expect(secondEntry.context?.relative_path).toBe(relativePath);

    const third = await runMermaidCli(["-c", "3回目"], env);
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toContain("[gpt-5-cli-mermaid]");
    expect(extractUserLines(third.stdout).at(-1)).toBe("Mermaid OK (3)");

    const historyAfterThird = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterThird.length).toBe(1);
    const thirdEntry = historyAfterThird[0];
    expect(thirdEntry.context?.cli).toBe("mermaid");
    expect(thirdEntry.request_count).toBe(3);
    expect(thirdEntry.context?.absolute_path).toBe(expectedAbsolutePath);
    expect(thirdEntry.context?.relative_path).toBe(relativePath);

    const summary = await runMermaidCli(["--compact", "1"], env);
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain("[gpt-5-cli-mermaid] compact: history=1");
    expect(extractUserLines(summary.stdout).at(-1)).toBe("Mermaid Summary");

    const historyAfterSummary = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterSummary.length).toBe(1);
    const summaryEntry = historyAfterSummary[0];
    expect(summaryEntry.context?.cli).toBe("mermaid");
    expect(summaryEntry.context?.absolute_path).toBe(expectedAbsolutePath);
    expect(summaryEntry.turns?.length).toBe(1);
    expect(summaryEntry.turns?.[0]?.role).toBe("system");
    expect(summaryEntry.turns?.[0]?.text).toBe("Mermaid Summary");
    expect(summaryEntry.resume?.summary?.text).toBe("Mermaid Summary");
    expect(summaryEntry.context?.relative_path).toBe(relativePath);
    expect(callIndex).toBe(responses.length);
  });

  test("既存の Mermaid ファイルを最終応答で上書きしない", async () => {
    currentHandler = async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        await request.json();
        const body = { id: "resp-mermaid", output_text: ["Mermaid OK"] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const env = createBaseEnv(server.port, historyPath);
    const uniqueDir = path.join("tmp", "mermaid-tests", crypto.randomUUID());
    const relativePath = path.join(uniqueDir, "sample.mmd");
    const absolutePath = path.resolve(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const sentinel = "graph TD;\n";
    fs.writeFileSync(absolutePath, sentinel, "utf8");

    const result = await runMermaidCli(["-o", relativePath, "既存ファイルテスト"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[gpt-5-cli-mermaid]");
    expect(extractUserLines(result.stdout).at(-1)).toBe("Mermaid OK");

    const persisted = fs.readFileSync(absolutePath, "utf8");
    expect(persisted).toBe(sentinel);

    fs.rmSync(path.dirname(absolutePath), { recursive: true, force: true });
  });
});
