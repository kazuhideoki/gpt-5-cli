/**
 * @file finalize 層のエントリーポイントに対するユニットテスト。
 */
import { describe, expect, it, mock } from "bun:test";
import type { ConfigEnvironment } from "../../types.js";
import type { FinalizeRequest } from "./types.js";
import { handleResult } from "./handle-result.js";

function createConfigEnv(values: Record<string, string | undefined> = {}): ConfigEnvironment {
  return {
    get: (key: string) => values[key],
    has: (key: string) => values[key] !== undefined,
    entries(): IterableIterator<readonly [key: string, value: string]> {
      const entries = Object.entries(values).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      return entries[Symbol.iterator]();
    },
  };
}

describe("handleResult", () => {
  it("既定のコンテンツを出力ハンドラーへ渡し、成果物メタデータを返す", async () => {
    const delivery = mock(async () => ({
      file: {
        absolutePath: "/workspace/out.txt",
        bytesWritten: 42,
      },
      copied: true,
    }));

    const request: FinalizeRequest = {
      content: "primary output",
      actions: [],
      output: {
        handler: delivery,
        params: {
          content: undefined,
          cwd: undefined,
          filePath: "out.txt",
          copy: undefined,
          copySource: undefined,
        },
      },
      configEnv: createConfigEnv(),
      stdout: undefined,
      history: undefined,
      exitCode: undefined,
    };

    const outcome = await handleResult(request);

    expect(delivery).toHaveBeenCalledTimes(1);
    const [firstCall] = delivery.mock.calls;
    expect(firstCall![0]).toMatchObject({
      content: "primary output",
      filePath: "out.txt",
    });
    expect(outcome.output).toEqual({
      filePath: "/workspace/out.txt",
      bytesWritten: 42,
      copied: true,
    });
  });

  it("履歴エフェクトを実行する", async () => {
    const historyEffect = mock(() => Promise.resolve());

    await handleResult({
      content: "history",
      actions: [],
      history: {
        run: historyEffect,
      },
      configEnv: createConfigEnv(),
      stdout: undefined,
      output: undefined,
      exitCode: undefined,
    });

    expect(historyEffect).toHaveBeenCalledTimes(1);
  });

  it("stdout と exitCode を上書きできる", async () => {
    const outcome = await handleResult({
      content: "fallback",
      stdout: "custom stdout",
      exitCode: 1,
      actions: [],
      configEnv: createConfigEnv(),
      output: undefined,
      history: undefined,
    });

    expect(outcome.stdout).toBe("custom stdout");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.output).toBeUndefined();
  });

  it("ConfigEnv を deliverOutput へ引き渡す", async () => {
    const configEnv = createConfigEnv({ SAMPLE_KEY: "value" });
    const delivery = mock(async () => ({ file: undefined }));

    await handleResult({
      content: "pass-through",
      actions: [],
      configEnv,
      output: {
        handler: delivery,
        params: {
          content: undefined,
          cwd: undefined,
          filePath: undefined,
          copy: undefined,
          copySource: undefined,
        },
      },
      stdout: undefined,
      history: undefined,
      exitCode: undefined,
    });

    expect(delivery).toHaveBeenCalledTimes(1);
    const [args] = delivery.mock.calls;
    expect(args?.[0]?.configEnv).toBe(configEnv);
  });

  it("アクションを優先順位順に実行する", async () => {
    // TODO: finalize-action 実行ロジックのテストを実装する
  });

  it.todo("tool アクションの実行は finalize-action 実装時に追加する");
});
