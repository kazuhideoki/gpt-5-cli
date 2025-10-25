/**
 * @file buildFileHistoryContext の挙動を検証する。
 */
import { describe, expect, it } from "bun:test";
import { buildFileHistoryContext, type FileHistoryContext } from "./history-context.js";

interface D2HistoryContext extends FileHistoryContext {
  cli: "d2";
}

describe("buildFileHistoryContext", () => {
  it("contextPath を absolute_path に反映する", () => {
    const context = buildFileHistoryContext<D2HistoryContext>({
      base: { cli: "d2" },
      contextPath: "/absolute/d2.d2",
      defaultFilePath: "relative.d2",
      copyOutput: false,
    });

    expect(context).toEqual({
      cli: "d2",
      absolute_path: "/absolute/d2.d2",
      relative_path: "relative.d2",
    });
  });

  it("contextPath が無い場合に defaultFilePath を relative_path として利用する", () => {
    const context = buildFileHistoryContext<D2HistoryContext>({
      base: { cli: "d2" },
      defaultFilePath: "relative.d2",
      copyOutput: false,
    });

    expect(context.relative_path).toBe("relative.d2");
  });

  it("copyOutput が true のとき copy フラグを設定する", () => {
    const context = buildFileHistoryContext<D2HistoryContext>({
      base: { cli: "d2" },
      historyArtifactPath: "result.d2",
      copyOutput: true,
    });

    expect(context).toEqual({
      cli: "d2",
      relative_path: "result.d2",
      copy: true,
    });
  });

  it("historyArtifactPath / copyOutput が無い場合は previousContext の相対パスを引き継ぐ", () => {
    const previous: D2HistoryContext = {
      cli: "d2",
      relative_path: "previous.d2",
      copy: true,
    };

    const context = buildFileHistoryContext<D2HistoryContext>({
      base: { cli: "d2" },
      copyOutput: false,
      previousContext: previous,
    });

    expect(context).toEqual({
      cli: "d2",
      relative_path: "previous.d2",
      copy: true,
    });
  });
});
