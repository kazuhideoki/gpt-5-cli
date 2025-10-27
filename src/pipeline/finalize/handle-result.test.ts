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
      output: {
        handler: delivery,
        params: {
          filePath: "out.txt",
        },
      },
      configEnv: createConfigEnv(),
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
      history: {
        run: historyEffect,
      },
      configEnv: createConfigEnv(),
    });

    expect(historyEffect).toHaveBeenCalledTimes(1);
  });

  it("stdout と exitCode を上書きできる", async () => {
    const outcome = await handleResult({
      content: "fallback",
      stdout: "custom stdout",
      exitCode: 1,
      configEnv: createConfigEnv(),
    });

    expect(outcome.stdout).toBe("custom stdout");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.output).toBeUndefined();
  });

  it("ConfigEnv を deliverOutput へ引き渡す", async () => {
    // TODO: 実装時に handler へ ConfigEnv が渡されることを検証する
  });
});
