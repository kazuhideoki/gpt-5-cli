/**
 * @file buildFileHistoryContext の挙動を検証する。
 */
import { describe, expect, it } from "bun:test";
import { buildFileHistoryContext, type FileHistoryContext } from "./history-context.js";

interface D2HistoryContext extends FileHistoryContext {
  cli: "d2";
}

describe("buildFileHistoryContext", () => {
  it("contextPath を file_path に反映する", () => {
    const context = buildFileHistoryContext<D2HistoryContext>({
      base: { cli: "d2" },
      contextPath: "/absolute/d2.d2",
      defaultFilePath: "relative.d2",
      copyOutput: false,
    });

    expect(context).toEqual({
      cli: "d2",
      file_path: "/absolute/d2.d2",
    });
  });

  it("contextPath が無い場合に defaultFilePath を利用する", () => {
    const context = buildFileHistoryContext<D2HistoryContext>({
      base: { cli: "d2" },
      defaultFilePath: "relative.d2",
      copyOutput: false,
    });

    expect(context.file_path).toBe("relative.d2");
  });

  it("copyOutput が true のとき output.copy を設定する", () => {
    const context = buildFileHistoryContext<D2HistoryContext>({
      base: { cli: "d2" },
      historyOutputFile: "result.d2",
      copyOutput: true,
    });

    expect(context.output).toEqual({
      file: "result.d2",
      copy: true,
    });
  });

  it("historyOutputFile / copyOutput が無い場合は previousContext.output を引き継ぐ", () => {
    const previous: D2HistoryContext = {
      cli: "d2",
      output: { file: "previous.d2", copy: true },
    };

    const context = buildFileHistoryContext<D2HistoryContext>({
      base: { cli: "d2" },
      copyOutput: false,
      previousContext: previous,
    });

    expect(context.output).toEqual({ file: "previous.d2", copy: true });
  });
});
