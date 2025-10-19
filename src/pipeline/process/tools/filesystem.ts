/**
 * ワークスペース上のファイル操作ツールを提供する。
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { ToolExecutionContext } from "./runtime.js";
import type { ToolRegistration, ToolResult } from "./runtime.js";

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

interface ReadFileResult extends ToolResult {
  path?: string;
  content?: string;
  encoding?: string;
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

interface WriteFileResult extends ToolResult {
  path?: string;
  bytes_written?: number;
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

export const READ_FILE_TOOL: ToolRegistration<ReadFileArgs, ReadFileResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "read_file",
    description: "Read a UTF-8 file from the workspace and return its contents.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to the workspace root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  handler: readFileTool,
};

export const WRITE_FILE_TOOL: ToolRegistration<WriteFileArgs, WriteFileResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "write_file",
    description:
      "Write a UTF-8 file within the workspace. Intermediate directories will be created.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to the workspace root.",
        },
        content: {
          type: "string",
          description: "Contents of the file to write. Must be UTF-8 text.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  handler: writeFileTool,
};
