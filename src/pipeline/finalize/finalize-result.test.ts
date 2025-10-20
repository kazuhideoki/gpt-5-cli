/**
 * @file finalizeResult の振る舞いを検証するユニットテスト。
 */
import { describe, expect, it, mock } from "bun:test";
import type { ConversationContext } from "../../types.js";
import type { HistoryStore } from "../history/store.js";
import { finalizeResult } from "./finalize-result.js";

type D2HistoryContext = {
  cli: "d2";
  file_path?: string;
  output?: {
    file?: string;
    copy?: boolean;
  };
};

type MermaidHistoryContext = {
  cli: "mermaid";
  file_path?: string;
  output?: {
    file?: string;
    copy?: boolean;
  };
};

const baseConversation: ConversationContext = {
  isNewConversation: true,
  titleToUse: "title",
  resumeBaseMessages: [],
};

describe("finalizeResult", () => {
  it("履歴コンテキストを構築し upsertConversation を呼び出す", async () => {
    const upsertConversation = mock(() => undefined);
    const historyStore = {
      upsertConversation,
    } as unknown as HistoryStore<D2HistoryContext>;

    const outcome = await finalizeResult<D2HistoryContext>({
      content: "assistant-content",
      userText: "user-input",
      summaryOutputPath: undefined,
      copyOutput: false,
      defaultOutputFilePath: "diagram.d2",
      history: {
        responseId: "resp-1",
        store: historyStore,
        conversation: baseConversation,
        metadata: { model: "gpt-test", effort: "low", verbosity: "medium" },
        previousContextRaw: undefined,
        baseContext: { cli: "d2" },
        contextPath: "/absolute/path.d2",
      },
    });

    expect(upsertConversation).toHaveBeenCalledTimes(1);
    const [call] = upsertConversation.mock.calls;
    const params = call![0];
    expect(params.userText).toBe("user-input");
    expect(params.assistantText).toBe("assistant-content");
    expect(params.contextData).toEqual({
      cli: "d2",
      file_path: "/absolute/path.d2",
      output: { file: "diagram.d2" },
    });
    expect(outcome.stdout).toBe("assistant-content");
  });

  it("contextPath が無い場合に previousContext の file_path を引き継ぐ", async () => {
    const previousContext: MermaidHistoryContext = {
      cli: "mermaid",
      file_path: "/from/history.mmd",
    };
    const upsertConversation = mock(() => undefined);
    const historyStore = {
      upsertConversation,
    } as unknown as HistoryStore<MermaidHistoryContext>;

    await finalizeResult<MermaidHistoryContext>({
      content: "diagram",
      userText: "describe diagram",
      summaryOutputPath: undefined,
      copyOutput: false,
      defaultOutputFilePath: undefined,
      history: {
        responseId: "resp-2",
        store: historyStore,
        conversation: baseConversation,
        metadata: { model: "gpt-test", effort: "medium", verbosity: "high" },
        previousContextRaw: previousContext,
        previousContext,
        baseContext: { cli: "mermaid" },
      },
    });

    expect(upsertConversation).toHaveBeenCalledTimes(1);
    const contextData = upsertConversation.mock.calls[0]![0].contextData as MermaidHistoryContext;
    expect(contextData.file_path).toBe("/from/history.mmd");
    expect(contextData.output).toBeUndefined();
  });

  it("responseId が無い場合は履歴更新を実行しない", async () => {
    const upsertConversation = mock(() => undefined);
    const historyStore = {
      upsertConversation,
    } as unknown as HistoryStore<D2HistoryContext>;

    await finalizeResult<D2HistoryContext>({
      content: "noop",
      userText: "noop",
      summaryOutputPath: undefined,
      copyOutput: false,
      history: {
        responseId: undefined,
        store: historyStore,
        conversation: baseConversation,
        metadata: { model: "noop", effort: "low", verbosity: "low" },
        previousContextRaw: undefined,
        baseContext: { cli: "d2" },
      },
    });

    expect(upsertConversation).not.toHaveBeenCalled();
  });
});
