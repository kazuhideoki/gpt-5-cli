import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export const projectRoot = path.resolve(import.meta.dir, "../..");

export function createTempHistoryPath(): { historyPath: string; cleanup: () => void } {
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

export async function runAskCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", "src/cli/ask.ts", ...args], {
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

export async function runD2Cli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", "src/cli/d2.ts", ...args], {
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

export async function runMermaidCli(
  args: string[],
  env: Record<string, string>,
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", "src/cli/mermaid.ts", ...args], {
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

export async function runSqlCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", "src/cli/sql.ts", ...args], {
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

export function createBaseEnv(port: number, historyPath: string): Record<string, string> {
  return {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    GPT_5_CLI_HISTORY_INDEX_FILE: historyPath,
  };
}

export function extractUserLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("[gpt-5-cli]") &&
        !line.startsWith("[gpt-5-cli-d2]") &&
        !line.startsWith("[gpt-5-cli-mermaid]") &&
        !line.startsWith("[gpt-5-cli-sql]"),
    );
}
