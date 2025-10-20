/**
 * D2 図ツール。
 */
import type { ToolExecutionContext } from "./runtime.js";
import type { CommandResult, ToolRegistration } from "./runtime.js";
import { runCommand } from "./command.js";
import { resolveWorkspacePath } from "./filesystem.js";

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

export const D2_CHECK_TOOL: ToolRegistration<D2Args, CommandResult> = {
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
};

export const D2_FMT_TOOL: ToolRegistration<D2Args, CommandResult> = {
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
};
