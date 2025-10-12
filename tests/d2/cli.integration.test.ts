import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  createBaseEnv,
  createTempHistoryPath,
  extractUserLines,
  projectRoot,
  runD2Cli,
  runDefaultCli,
} from "../helpers/cli";

describe("d2 CLI integration", () => {
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

  test("d2 モード: 履歴に絶対パスを保持し継続時も固定される", async () => {
    const responses = [
      { id: "resp-d2-1", text: "D2 OK (1)" },
      { id: "resp-d2-2", text: "D2 OK (2)" },
      { id: "resp-d2-3", text: "D2 OK (3)" },
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
    const relativePath = path.join("diagrams", "sample.d2");
    const expectedAbsolutePath = path.resolve(projectRoot, relativePath);

    const first = await runDefaultCli(["-D", "-F", relativePath, "初回D2"], env);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("[gpt-5-cli-d2]");
    expect(extractUserLines(first.stdout).at(-1)).toBe("D2 OK (1)");

    expect(fs.existsSync(historyPath)).toBe(true);
    const historyAfterFirst = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterFirst.length).toBe(1);
    const firstEntry = historyAfterFirst[0];
    expect(firstEntry.task?.d2?.file_path).toBe(expectedAbsolutePath);
    expect(firstEntry.request_count).toBe(1);

    const second = await runDefaultCli(["-c", "2回目"], env);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("[gpt-5-cli-d2]");
    expect(extractUserLines(second.stdout).at(-1)).toBe("D2 OK (2)");

    const historyAfterSecond = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterSecond.length).toBe(1);
    const secondEntry = historyAfterSecond[0];
    expect(secondEntry.request_count).toBe(2);
    expect(secondEntry.task?.d2?.file_path).toBe(expectedAbsolutePath);
    const third = await runD2Cli(["-c", "3回目"], env);
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toContain("[gpt-5-cli-d2]");
    expect(extractUserLines(third.stdout).at(-1)).toBe("D2 OK (3)");

    const historyAfterThird = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterThird.length).toBe(1);
    const thirdEntry = historyAfterThird[0];
    expect(thirdEntry.request_count).toBe(3);
    expect(thirdEntry.task?.d2?.file_path).toBe(expectedAbsolutePath);
    expect(callIndex).toBe(responses.length);
  });

  test("d2 履歴を --compact で要約できる", async () => {
    const responses = [
      { id: "resp-d2-1", text: "D2 OK (1)" },
      { id: "resp-d2-2", text: "D2 OK (2)" },
      { id: "resp-d2-3", text: "D2 OK (3)" },
      { id: "resp-d2-summary", text: "D2 Summary" },
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
    const relativePath = path.join("diagrams", "sample.d2");
    const expectedAbsolutePath = path.resolve(projectRoot, relativePath);

    const first = await runDefaultCli(["-D", "-F", relativePath, "初回D2"], env);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("[gpt-5-cli-d2]");
    expect(extractUserLines(first.stdout).at(-1)).toBe("D2 OK (1)");

    const second = await runDefaultCli(["-c", "2回目"], env);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("[gpt-5-cli-d2]");

    const third = await runD2Cli(["-c", "3回目"], env);
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toContain("[gpt-5-cli-d2]");

    const summary = await runDefaultCli(["--compact", "1"], env);
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain("[gpt-5-cli-d2] compact: history=1");
    expect(extractUserLines(summary.stdout).at(-1)).toBe("D2 Summary");

    const historyAfterSummary = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterSummary.length).toBe(1);
    const entry = historyAfterSummary[0];
    expect(entry.task?.d2?.file_path).toBe(expectedAbsolutePath);
    expect(entry.turns?.length).toBe(1);
    expect(entry.turns?.[0]?.role).toBe("system");
    expect(entry.turns?.[0]?.text).toBe("D2 Summary");
    expect(entry.resume?.summary?.text).toBe("D2 Summary");
    expect(callIndex).toBe(responses.length);
  });
});
