/**
 * Mermaid CLI 用のツール群。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import type { ToolExecutionContext } from "./runtime.js";
import type { CommandResult, ToolRegistration } from "./runtime.js";
import { runCommand } from "./command.js";
import { resolveWorkspacePath } from "./filesystem.js";

const MERMAID_BIN_NAME = process.platform === "win32" ? "mmdc.cmd" : "mmdc";

interface MermaidArgs {
  file_path: string;
}

interface ResolvedMermaidCommand {
  command: string;
  args: string[];
}

interface MermaidPackageJsonShape {
  bin?: string | Record<string, string>;
}

export async function resolveMermaidCommand(): Promise<ResolvedMermaidCommand> {
  const requireFromHere = createRequire(import.meta.url);

  try {
    const packageJsonPath = requireFromHere.resolve("@mermaid-js/mermaid-cli/package.json");
    const packageDirectory = path.dirname(packageJsonPath);
    const packageJsonContent = await fs.readFile(packageJsonPath, { encoding: "utf8" });
    const packageJson = JSON.parse(packageJsonContent) as MermaidPackageJsonShape;
    const binField = packageJson.bin;

    let scriptRelative: string | undefined;

    if (typeof binField === "string") {
      scriptRelative = binField;
    } else if (binField && typeof binField === "object") {
      const record = binField as Record<string, unknown>;
      const prioritizedKeys = ["mmdc", "mermaid"];
      for (const key of prioritizedKeys) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.length > 0) {
          scriptRelative = candidate;
          break;
        }
      }
      if (!scriptRelative) {
        const fallback = Object.values(record).find(
          (entry): entry is string => typeof entry === "string" && entry.length > 0,
        );
        scriptRelative = fallback;
      }
    }

    if (typeof scriptRelative === "string" && scriptRelative.length > 0) {
      const scriptAbsolute = path.resolve(packageDirectory, scriptRelative);
      await fs.access(scriptAbsolute);
      return { command: process.execPath, args: [scriptAbsolute] };
    }
  } catch {
    // ignore and fall through to PATH lookup
  }

  return { command: MERMAID_BIN_NAME, args: [] };
}

async function mermaidCheckTool(
  args: MermaidArgs,
  context: ToolExecutionContext,
): Promise<CommandResult> {
  const { cwd } = context;
  const resolvedPath = resolveWorkspacePath(args.file_path, cwd);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-5-mermaid-check-"));
  const outputPath = path.join(tempDir, "mermaid-output.svg");
  const { command, args: commandArgs } = await resolveMermaidCommand();
  const argsWithTargets = [...commandArgs, "-i", resolvedPath, "-o", outputPath, "--quiet"];
  try {
    return await runCommand(command, argsWithTargets, cwd);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export const MERMAID_CHECK_TOOL: ToolRegistration<MermaidArgs, CommandResult> = {
  definition: {
    type: "function",
    strict: true,
    name: "mermaid_check",
    description:
      "Run mermaid-cli to validate a Mermaid diagram file. When using Markdown, wrap the diagram in a ```mermaid``` block.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the Mermaid file relative to the workspace root.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  handler: mermaidCheckTool,
};
