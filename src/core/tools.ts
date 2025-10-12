import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";

/** ツール実行時に利用する作業ディレクトリとロガーを保持する。 */
interface ToolExecutionContext {
  cwd: string;
  log: (message: string) => void;
}

/**
 * ツール実行結果の基本形。CLI固有の拡張フィールドも許容する。
 */
export interface ToolResult {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

interface ReadFileResult extends ToolResult {
  path?: string;
  content?: string;
  encoding?: string;
}

interface WriteFileResult extends ToolResult {
  path?: string;
  bytes_written?: number;
}

interface CommandResult extends ToolResult {
  command: string;
  args: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
}

type ToolHandler<
  TArgs = unknown,
  TResult extends ToolResult = ToolResult,
  TContext extends ToolExecutionContext = ToolExecutionContext,
> = (args: TArgs, context: TContext) => Promise<TResult>;

export interface ToolRegistration<
  TArgs = unknown,
  TResult extends ToolResult = ToolResult,
  TContext extends ToolExecutionContext = ToolExecutionContext,
> {
  definition: FunctionTool;
  handler: ToolHandler<TArgs, TResult, TContext>;
}

interface ToolRuntime<TContext extends ToolExecutionContext = ToolExecutionContext> {
  tools: FunctionTool[];
  execute(call: ResponseFunctionToolCall, context: TContext): Promise<string>;
}

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

interface ReadFileArgs {
  path: string;
}

async function readFileTool(
  args: ReadFileArgs,
  context: ToolExecutionContext,
): Promise<ReadFileResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.path, cwd);
  const buffer = await fs.readFile(resolvedPath, { encoding: "utf8" });
  return {
    success: true,
    path: path.relative(cwd, resolvedPath),
    content: buffer,
    encoding: "utf8",
  };
}

interface WriteFileArgs {
  path: string;
  content: string;
}

async function writeFileTool(
  args: WriteFileArgs,
  context: ToolExecutionContext,
): Promise<WriteFileResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.path, cwd);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, args.content, { encoding: "utf8" });
  return {
    success: true,
    path: path.relative(cwd, resolvedPath),
    bytes_written: Buffer.byteLength(args.content, "utf8"),
  };
}

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

interface D2Args {
  file_path: string;
}

async function d2CheckTool(args: D2Args, context: ToolExecutionContext): Promise<CommandResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.file_path, cwd);
  return runCommand("d2", [resolvedPath], cwd);
}

async function d2FmtTool(args: D2Args, context: ToolExecutionContext): Promise<CommandResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.file_path, cwd);
  return runCommand("d2", ["fmt", resolvedPath], cwd);
}

const CORE_TOOL_REGISTRATIONS = [
  {
    definition: {
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
    handler: readFileTool,
  } satisfies ToolRegistration<ReadFileArgs, ReadFileResult>,
  {
    definition: {
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
    handler: writeFileTool,
  } satisfies ToolRegistration<WriteFileArgs, WriteFileResult>,
  {
    definition: {
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
    handler: d2CheckTool,
  } satisfies ToolRegistration<D2Args, CommandResult>,
  {
    definition: {
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
    handler: d2FmtTool,
  } satisfies ToolRegistration<D2Args, CommandResult>,
] as ToolRegistration<any, ToolResult>[];

/**
 * CLI共通の関数ツール実行基盤を生成する。追加ツールを差し込むこともできる。
 *
 * @param extraTools CLI固有に追加するツール定義。
 * @returns 関数ツールの一覧と実行メソッド。
 */
export function createCoreToolRuntime<TContext extends ToolExecutionContext = ToolExecutionContext>(
  extraTools: Iterable<ToolRegistration<any, any, TContext>> = [],
): ToolRuntime<TContext> {
  return createToolRuntime<TContext>([...CORE_TOOL_REGISTRATIONS, ...extraTools]);
}

/**
 * 任意のツール定義集合から実行ランタイムを構築する。
 *
 * @param registrations ツール定義とハンドラの配列。
 * @returns ツール一覧と実行メソッド。
 */
function createToolRuntime<TContext extends ToolExecutionContext = ToolExecutionContext>(
  registrations: Iterable<ToolRegistration<any, any, TContext>>,
): ToolRuntime<TContext> {
  const entries = Array.from(registrations);
  const handlerMap = new Map<string, ToolHandler<any, ToolResult, TContext>>();
  for (const entry of entries) {
    if (handlerMap.has(entry.definition.name)) {
      throw new Error(`Duplicate tool name detected: ${entry.definition.name}`);
    }
    handlerMap.set(entry.definition.name, entry.handler);
  }

  async function execute(call: ResponseFunctionToolCall, context: TContext): Promise<string> {
    const { log } = context;
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
        } satisfies ToolResult;
        return JSON.stringify(payload);
      }
    }

    log(`[tool] ${toolName} invoked`);
    const handler = handlerMap.get(toolName);
    if (!handler) {
      const payload = { success: false, message: `Unknown tool: ${toolName}` } satisfies ToolResult;
      return JSON.stringify(payload);
    }

    try {
      const result = await handler(parsedArgs, context);
      return JSON.stringify(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload = { success: false, message } satisfies ToolResult;
      return JSON.stringify(payload);
    }
  }

  return {
    tools: entries.map((entry) => entry.definition),
    execute,
  };
}

export const CORE_FUNCTION_TOOLS = CORE_TOOL_REGISTRATIONS.map((entry) => entry.definition);

/**
 * OpenAI Responses API へ渡すツール設定を構築する。
 *
 * @returns CLI が利用可能な関数ツールとプレビュー検索の配列。
 */
export function buildCliToolList(): ResponseCreateParamsNonStreaming["tools"] {
  return [...CORE_FUNCTION_TOOLS, { type: "web_search_preview" as const }];
}
