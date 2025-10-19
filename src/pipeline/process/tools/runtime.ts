/**
 * ツール実行ランタイムと共通インターフェースを提供するモジュール。
 * Pipeline Process 層からツールを起動するときの土台となる。
 */
import { tool as defineAgentTool } from "@openai/agents";
import type { Tool as AgentsSdkTool } from "@openai/agents";
import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
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

export interface ToolRuntime<TContext extends ToolExecutionContext = ToolExecutionContext> {
  tools: FunctionTool[];
  execute(call: ResponseFunctionToolCall, context: TContext): Promise<string>;
}

/**
 * 任意のツール定義集合から実行ランタイムを構築する。
 *
 * @param registrations ツール定義とハンドラの配列。
 * @returns ツール一覧と実行メソッド。
 */
export function createToolRuntime<TContext extends ToolExecutionContext = ToolExecutionContext>(
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

interface BuildAgentsToolListOptions {
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

export function buildCliToolList(
  registrations: Iterable<ToolRegistration<any, any>>,
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

  return [...functionTools, { type: "web_search_preview" as const }];
}
