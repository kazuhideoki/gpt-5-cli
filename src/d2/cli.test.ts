import { describe, expect, it } from "bun:test";
import { parseArgs } from "./cli.js";
import type { CliDefaults } from "../cli/default/types.js";

function createDefaults(): CliDefaults {
  return {
    modelMain: "gpt-5-main",
    modelMini: "gpt-5-mini",
    modelNano: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    historyIndexPath: "/tmp/history.json",
    promptsDir: "/tmp/prompts",
    d2MaxIterations: 8,
  };
}

describe("d2 parseArgs", () => {
  it("既定で d2 モードとして解析する", () => {
    const defaults = createDefaults();
    const options = parseArgs(["ダイアグラム"], defaults);
    expect(options.taskMode).toBe("d2");
    expect(options.taskModeExplicit).toBe(false);
    expect(options.args).toEqual(["ダイアグラム"]);
  });

  it("互換フラグ -D を指定すると明示扱いになる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["-D", "diagram"], defaults);
    expect(options.taskMode).toBe("d2");
    expect(options.taskModeExplicit).toBe(true);
  });

  it("--d2-iterations でツール呼び出し上限を設定できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--d2-iterations", "5", "図"], defaults);
    expect(options.d2MaxIterations).toBe(5);
    expect(options.d2MaxIterationsExplicit).toBe(true);
  });

  it("--d2-iterations へ不正な値を渡すとエラーになる", () => {
    const defaults = createDefaults();
    expect(() => parseArgs(["--d2-iterations", "0", "図"], defaults)).toThrow(
      "Error: --d2-iterations の値は 1 以上で指定してください",
    );
  });

  it("--d2-file で出力パスを指定できる", () => {
    const defaults = createDefaults();
    const options = parseArgs(["--d2-file", "diagram.d2", "生成"], defaults);
    expect(options.d2FilePath).toBe("diagram.d2");
    expect(options.d2FileExplicit).toBe(true);
  });
});
