/**
 * ツール実行ランタイムと共通インターフェースを提供するモジュール。
 * Pipeline Process 層からツールを起動するときの土台となる。
 */
import { tool as defineAgentTool } from "@openai/agents";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";

export interface ToolExecutionContext {
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

/**
 * Responses API と Agents SDK の双方で利用するツール配列をまとめたセット。
 * CLI 層ではこの型を用いて、API リクエストとエージェント実行に同じ構成を共有する。
 */
export interface ConversationToolset {
  /**
   * Responses API リクエストに添付する Function Tool / web_search_preview 定義群。
   */
  response: ResponseCreateParamsNonStreaming["tools"];
  /**
   * Agents SDK でアクティブにするツール定義群。
   */
  agents: AgentsSdkTool[];
}

export interface CommandResult extends ToolResult {
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

export interface BuildAgentsToolListOptions {
  createExecutionContext?: () => ToolExecutionContext;
  debugLog?: (message: string) => void;
  logLabel?: string;
}

/**
 * Agents SDK で利用可能なツール配列を構築する。
 *
 * @param registrations CLI 向けに登録済みのツール定義。
 * @param options 実行時ログやデバッグ出力の設定。
 * @returns Agents SDK で利用可能なツール配列。
 */
export function buildAgentsToolList(
  registrations: Iterable<ToolRegistration<any, any>>,
  options: BuildAgentsToolListOptions = {},
): AgentsSdkTool[] {
  const entries = Array.from(registrations).filter(
    (registration) => registration.definition.type === "function",
  );
  const logPrefix = options.logLabel ? `${options.logLabel} ` : "";
  const defaultExecutionContext =
    options.createExecutionContext ??
    (() => ({
      cwd: process.cwd(),
      log: (message: string) => {
        console.log(`${logPrefix}${message}`);
      },
    }));

  const formatJsonSnippet = (value: unknown, limit = 600): string => {
    try {
      const pretty = JSON.stringify(value, null, 2);
      if (pretty.length <= limit) {
        return pretty;
      }
      return `${pretty.slice(0, limit)}…(+${pretty.length - limit} chars)`;
    } catch {
      const serialized = String(value ?? "");
      if (serialized.length <= limit) {
        return serialized;
      }
      return `${serialized.slice(0, limit)}…(+${serialized.length - limit} chars)`;
    }
  };

  const formatPlainSnippet = (raw: string, limit = 600): string => {
    const text = raw.trim();
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}…(+${text.length - limit} chars)`;
  };

  type AgentExecutionDetails = { toolCall?: { call_id?: string; id?: string } };

  return entries.map((registration) => {
    const { definition, handler } = registration;
    return defineAgentTool({
      name: definition.name,
      description: definition.description ?? "",
      parameters: definition.parameters as any,
      strict: definition.strict ?? false,
      execute: async (
        input: unknown,
        _runContext: unknown,
        details?: AgentExecutionDetails,
      ): Promise<string> => {
        const context = defaultExecutionContext();
        const callId = details?.toolCall?.call_id ?? details?.toolCall?.id ?? "";
        const label = callId ? `${definition.name} (${callId})` : definition.name;
        context.log(`tool handling ${label}`);
        if (options.debugLog) {
          options.debugLog(`tool_call ${label} arguments:\n${formatJsonSnippet(input ?? {})}`);
        }

        let result: ToolResult | string;
        try {
          const args = (input ?? {}) as Record<string, unknown>;
          result = await handler(args, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          context.log(`tool error ${label}: ${message}`);
          if (options.debugLog) {
            options.debugLog(`tool_call ${label} failed: ${message}`);
          }
          return JSON.stringify({ success: false, message });
        }

        const serialized = typeof result === "string" ? result : JSON.stringify(result);
        if (options.debugLog) {
          options.debugLog(`tool_call ${label} output:\n${formatPlainSnippet(serialized)}`);
        }
        return serialized;
      },
    });
  });
}

interface BuildCliToolListConfig {
  appendWebSearchPreview: boolean;
}

export function buildCliToolList(
  registrations: Iterable<ToolRegistration<any, any>>,
  config: BuildCliToolListConfig,
): ResponseCreateParamsNonStreaming["tools"] {
  const functionTools: ResponseCreateParamsNonStreaming["tools"] = [];
  const seen = new Set<string>();

  for (const registration of registrations) {
    const { definition } = registration;
    if (definition.type !== "function") {
      continue;
    }
    if (seen.has(definition.name)) {
      continue;
    }
    functionTools.push(definition);
    seen.add(definition.name);
  }

  if (config.appendWebSearchPreview) {
    return [...functionTools, { type: "web_search_preview" as const }];
  }

  return functionTools;
}

interface BuildConversationToolsetOptions {
  cli: BuildCliToolListConfig;
  agents: BuildAgentsToolListOptions;
  additionalAgentTools: AgentsSdkTool[];
}

/**
 * Responses API 用と Agents SDK 用のツール配列を同時に構築する。
 */
export function buildConversationToolset(
  registrations: Iterable<ToolRegistration<any, any>>,
  options: BuildConversationToolsetOptions,
): ConversationToolset {
  const responseTools = buildCliToolList(registrations, options.cli);
  const agentBaseTools = buildAgentsToolList(registrations, options.agents);
  const agentTools =
    options.additionalAgentTools.length > 0
      ? [...agentBaseTools, ...options.additionalAgentTools]
      : agentBaseTools;
  return {
    response: responseTools,
    agents: agentTools,
  };
}
