import { afterEach, describe, expect, mock, test } from "bun:test";
import type { HistoryStore } from "../history/store.js";
import {
  handleResult,
  resetDeliverOutputImplementation,
  setDeliverOutputImplementation,
} from "./handle-result.js";

const deliverOutputSpy = mock(async () => ({
  file: { absolutePath: "/tmp/file.txt", bytesWritten: 12 },
  copied: true,
}));

afterEach(() => {
  deliverOutputSpy.mock.calls.length = 0;
  deliverOutputSpy.mock.results.length = 0;
  resetDeliverOutputImplementation();
});

describe("handleResult", () => {
  test("出力パラメータなしで標準出力と exitCode を返す", async () => {
    setDeliverOutputImplementation(deliverOutputSpy);
    const outcome = await handleResult({
      mode: "ask",
      content: "hello",
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("hello");
    expect(outcome.output).toBeUndefined();
    expect(deliverOutputSpy).not.toHaveBeenCalled();
  });

  test("出力指定がある場合は deliverOutput を呼び結果を含める", async () => {
    setDeliverOutputImplementation(deliverOutputSpy);
    const outcome = await handleResult({
      mode: "ask",
      content: "artifact",
      output: {
        filePath: "output.txt",
        copy: true,
      },
    });
    expect(deliverOutputSpy).toHaveBeenCalledTimes(1);
    const [callArgs] = deliverOutputSpy.mock.calls[0] ?? [];
    expect(callArgs).toMatchObject({ content: "artifact", filePath: "output.txt", copy: true });
    expect(outcome.output?.filePath).toBe("/tmp/file.txt");
    expect(outcome.output?.bytesWritten).toBe(12);
    expect(outcome.output?.copied).toBe(true);
  });

  test("履歴指定がある場合は upsertConversation を呼ぶ", async () => {
    const upsertConversation = mock(() => {});
    const fakeStore: Pick<HistoryStore<any>, "upsertConversation"> = {
      upsertConversation,
    };

    const outcome = await handleResult({
      mode: "ask",
      content: "history ok",
      history: {
        store: fakeStore as HistoryStore,
        metadata: {
          model: "gpt-5-mini",
          effort: "medium",
          verbosity: "medium",
        },
        context: {
          isNewConversation: true,
          titleToUse: "title",
        },
        responseId: "resp-123",
        userText: "user",
        assistantText: "assistant",
        contextData: { foo: "bar" },
      },
    });
    expect(outcome.exitCode).toBe(0);
    expect(upsertConversation).toHaveBeenCalledTimes(1);
    const [upsertArg] = upsertConversation.mock.calls[0] ?? [];
    expect(upsertArg).toMatchObject({
      responseId: "resp-123",
      assistantText: "assistant",
      userText: "user",
      contextData: { foo: "bar" },
    });
  });
});
