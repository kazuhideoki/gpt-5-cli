/**
 * 子プロセス実行に関するユーティリティ。
 */
import { spawn } from "node:child_process";

import type { CommandResult } from "./runtime.js";

export async function runCommand(
  command: string,
  commandArgs: string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const proc = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    proc.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    proc.on("error", (error) => {
      resolve({
        success: false,
        command,
        args: commandArgs,
        exit_code: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: `${Buffer.concat(stderrChunks).toString("utf8")}${error.message}`,
        message: error.message,
      });
    });

    proc.on("close", (code) => {
      resolve({
        success: (code ?? 1) === 0,
        command,
        args: commandArgs,
        exit_code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}
