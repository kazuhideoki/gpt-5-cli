import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FunctionTool, ResponseFunctionToolCall } from "openai/resources/responses/responses";

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

async function d2CheckTool(args: any, cwd: string): Promise<CommandResult> {
  const resolvedPath = resolveWorkspacePath(String(args?.file_path), cwd);
  return runCommand("d2", [resolvedPath], cwd);
}

async function d2FmtTool(args: any, cwd: string): Promise<CommandResult> {
  const resolvedPath = resolveWorkspacePath(String(args?.file_path), cwd);
  return runCommand("d2", ["fmt", resolvedPath], cwd);
}

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
