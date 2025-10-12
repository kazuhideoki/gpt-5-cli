import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const projectRoot = path.resolve(import.meta.dir, "../..");

function createTempHistoryPath(): { historyPath: string; cleanup: () => void } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt5-cli-int-"));
  const historyPath = path.join(tempDir, "history_index.json");
  return {
    historyPath,
    cleanup: () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", "src/cli/default/cli.ts", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function runD2Cli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", "src/d2/cli.ts", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

function createBaseEnv(port: number, historyPath: string): Record<string, string> {
  return {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    GPT_5_CLI_HISTORY_INDEX_FILE: historyPath,
  };
}

function extractUserLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("[gpt-5-cli]") && !line.startsWith("[gpt-5-cli-d2]"),
    );
}

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
    const result = await runCli(["正常テスト"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[gpt-5-cli]");
    expect(extractUserLines(result.stdout).at(-1)).toBe("OK!");

    expect(fs.existsSync(historyPath)).toBe(true);
    const historyRaw = fs.readFileSync(historyPath, "utf8");
    const historyData = JSON.parse(historyRaw) as Array<{
      last_response_id?: string;
      turns?: Array<{ role?: string; text?: string }>;
      request_count?: number;
    }>;
    expect(historyData.length).toBe(1);
    const [entry] = historyData;
    expect(entry.last_response_id).toBe("resp-1");
    expect(entry.request_count).toBe(1);
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
    const result = await runCli(["異常テスト"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[gpt-5-cli]");
    expect(extractUserLines(result.stdout)).toHaveLength(0);
    expect(result.stderr).toContain("mock failure");
    expect(fs.existsSync(historyPath)).toBe(false);
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

    const first = await runCli(["-D", "-F", relativePath, "初回D2"], env);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("[gpt-5-cli-d2]");
    expect(extractUserLines(first.stdout).at(-1)).toBe("D2 OK (1)");

    expect(fs.existsSync(historyPath)).toBe(true);
    const historyAfterFirst = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Array<any>;
    expect(historyAfterFirst.length).toBe(1);
    const firstEntry = historyAfterFirst[0];
    expect(firstEntry.task?.d2?.file_path).toBe(expectedAbsolutePath);
    expect(firstEntry.request_count).toBe(1);

    const second = await runCli(["-c", "2回目"], env);
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

  test("--compact は他の履歴系フラグと併用できない", async () => {
    currentHandler = () =>
      new Response("unexpected request", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });

    const env = createBaseEnv(server.port, historyPath);
    const result = await runCli(["--compact", "1", "-c"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[gpt-5-cli]");
    expect(extractUserLines(result.stdout)).toHaveLength(0);
    expect(result.stderr).toContain("Error: --compact と他のフラグは併用できません");
  });
});
