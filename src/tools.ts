import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FunctionTool, ResponseFunctionToolCall } from "openai/resources/responses/responses";

/** ツール実行時に利用する作業ディレクトリとロガーを保持する。 */
export interface ToolExecutionContext {
  cwd: string;
  log: (message: string) => void;
}

interface BaseToolResult {
  success: boolean;
  message?: string;
}

type ReadFileResult = BaseToolResult & {
  path?: string;
  content?: string;
  encoding?: string;
};

type WriteFileResult = BaseToolResult & {
  path?: string;
  bytes_written?: number;
};

type CommandResult = BaseToolResult & {
  command: string;
  args: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
};

/** OpenAIへ公開する関数ツール一覧。 */
export const FUNCTION_TOOLS: FunctionTool[] = [
  {
    type: "function",
    strict: true,
    name: "read_file",
    description: "Read a UTF-8 text file from the local workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    strict: true,
    name: "write_file",
    description:
      "Overwrite a text file in the local workspace using UTF-8. Creates the file if it does not exist.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Target file path relative to the workspace root.",
        },
        content: {
          type: "string",
          description: "Text content to write into the file.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    strict: true,
    name: "d2_check",
    description: "Run `d2` to validate a diagram file without modifying it.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the D2 file relative to the workspace root.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    strict: true,
    name: "d2_fmt",
    description: "Run `d2 fmt` to format a diagram file in-place.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the D2 file relative to the workspace root.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
];

/**
 * ワークスペース内の安全なパスへ正規化し、外部アクセスを防ぐ。
 *
 * @param rawPath ユーザーから指定されたパス。
 * @param cwd ワークスペースのルート。
 * @returns 絶対パス。
 */
export function resolveWorkspacePath(rawPath: string, cwd: string): string {
  if (!rawPath || rawPath.trim().length === 0) {
    throw new Error("path must be a non-empty string");
  }
  const normalizedRoot = path.resolve(cwd);
  const candidate = path.resolve(normalizedRoot, rawPath);
  const relative = path.relative(normalizedRoot, candidate);
  const isInsideWorkspace =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInsideWorkspace) {
    throw new Error(`Access to path outside workspace is not allowed: ${rawPath}`);
  }
  return candidate;
}

/**
 * read_fileツールの実装。ファイルをUTF-8で読み込む。
 *
 * @param args ツール呼び出し引数。
 * @param cwd ワークスペースルート。
 * @returns 読み取った内容。
 */
async function readFileTool(args: any, cwd: string): Promise<ReadFileResult> {
  const resolvedPath = resolveWorkspacePath(String(args?.path), cwd);
  const buffer = await fs.readFile(resolvedPath, { encoding: "utf8" });
  return {
    success: true,
    path: path.relative(cwd, resolvedPath),
    content: buffer,
    encoding: "utf8",
  };
}

/**
 * write_fileツールの実装。UTF-8でファイルを上書きする。
 *
 * @param args ツール呼び出し引数。
 * @param cwd ワークスペースルート。
 * @returns 書き込み結果。
 */
async function writeFileTool(args: any, cwd: string): Promise<WriteFileResult> {
  const resolvedPath = resolveWorkspacePath(String(args?.path), cwd);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const content = String(args?.content ?? "");
  await fs.writeFile(resolvedPath, content, { encoding: "utf8" });
  return {
    success: true,
    path: path.relative(cwd, resolvedPath),
    bytes_written: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * サブプロセスでコマンドを実行し、結果を収集する。
 *
 * @param command 実行するコマンド。
 * @param commandArgs 引数配列。
 * @param cwd 実行ディレクトリ。
 * @returns 実行結果。
 */
async function runCommand(
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

/**
 * d2の構文チェックを実行するツール。
 *
 * @param args ツール引数。
 * @param cwd ワークスペースルート。
 * @returns コマンド結果。
 */
async function d2CheckTool(args: any, cwd: string): Promise<CommandResult> {
  const resolvedPath = resolveWorkspacePath(String(args?.file_path), cwd);
  return runCommand("d2", [resolvedPath], cwd);
}

/**
 * d2 fmtを実行し、ダイアグラムファイルを整形するツール。
 *
 * @param args ツール引数。
 * @param cwd ワークスペースルート。
 * @returns コマンド結果。
 */
async function d2FmtTool(args: any, cwd: string): Promise<CommandResult> {
  const resolvedPath = resolveWorkspacePath(String(args?.file_path), cwd);
  return runCommand("d2", ["fmt", resolvedPath], cwd);
}

/**
 * OpenAIからのツール呼び出しを受け取り、ローカル実装へディスパッチする。
 *
 * @param call Responses APIからのツール呼び出し。
 * @param context 実行時コンテキスト。
 * @returns JSON文字列化したツール結果。
 */
export async function executeFunctionToolCall(
  call: ResponseFunctionToolCall,
  context: ToolExecutionContext,
): Promise<string> {
  const { log, cwd } = context;
  const toolName = call.name;
  let parsedArgs: any = {};
  if (call.arguments) {
    try {
      parsedArgs = JSON.parse(call.arguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload = {
        success: false,
        message: `Failed to parse arguments for ${toolName}: ${message}`,
      };
      return JSON.stringify(payload);
    }
  }

  log(`[tool] ${toolName} invoked`);
  try {
    switch (toolName) {
      case "read_file":
        return JSON.stringify(await readFileTool(parsedArgs, cwd));
      case "write_file":
        return JSON.stringify(await writeFileTool(parsedArgs, cwd));
      case "d2_check":
        return JSON.stringify(await d2CheckTool(parsedArgs, cwd));
      case "d2_fmt":
        return JSON.stringify(await d2FmtTool(parsedArgs, cwd));
      default: {
        const payload = { success: false, message: `Unknown tool: ${toolName}` };
        return JSON.stringify(payload);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = { success: false, message };
    return JSON.stringify(payload);
  }
}
