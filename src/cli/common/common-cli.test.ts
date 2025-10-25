import { describe, expect, it } from "bun:test";
import type { CliDefaults } from "../../types.js";
import { buildCommonCommand, parseCommonOptions } from "./common-cli.js";

function createDefaults(): CliDefaults {
  return {
    modelMain: "gpt-5-main",
    modelMini: "gpt-5-mini",
    modelNano: "gpt-5-nano",
    effort: "low",
    verbosity: "low",
    historyIndexPath: "/tmp/history.json",
    promptsDir: "/tmp/prompts",
    maxIterations: 8,
  };
}

function buildCommand(overrides: Partial<Parameters<typeof buildCommonCommand>[0]> = {}) {
  const defaults = overrides.defaults ?? createDefaults();
  const commandOptions = {
    defaults,
    mode: overrides.mode ?? "ask",
    argument: overrides.argument ?? { tokens: "[input...]", description: "入力" },
    extraOptionRegistrars: overrides.extraOptionRegistrars ?? [],
  };
  return buildCommonCommand(commandOptions);
}

describe("buildCommonCommand", () => {
  it("共通フラグのヘルプ・説明文を登録する", () => {
    const command = buildCommand();
    const optionFlags = command.options.map((option) => option.flags);
    expect(optionFlags).toContain("-m, --model <index>");
    expect(optionFlags).toContain("-e, --effort <index>");
    expect(optionFlags).toContain("-v, --verbosity <index>");
    expect(optionFlags).toContain("-c, --continue-conversation");
    expect(optionFlags).toContain("-r, --resume [index]");
    expect(optionFlags).toContain("-d, --delete [index]");
    expect(optionFlags).toContain("-s, --show [index]");
    expect(optionFlags).toContain("--debug");
    expect(optionFlags).toContain("-i, --image <path>");
    expect(optionFlags).toContain("-o, --output <path>");
    expect(optionFlags).toContain("--copy");
    expect(optionFlags).toContain("-I, --iterations <count>");
    expect(optionFlags).toContain("--compact <index>");
    const helpText = command.helpInformation();
    expect(helpText).toContain("-?, --help");
  });

  it("モード固有の追加 registrar を呼び出して統合する", () => {
    const command = buildCommand({
      extraOptionRegistrars: [
        (program) => {
          program.option("--extra-flag", "追加フラグ");
        },
      ],
    });
    const optionFlags = command.options.map((option) => option.flags);
    expect(optionFlags).toContain("--extra-flag");
  });
});

describe("parseCommonOptions", () => {
  it("既定値と CLI 指定値を統合した CommonCliOptions を返す", () => {
    const defaults = createDefaults();
    const command = buildCommand({ defaults });
    const { options } = parseCommonOptions(
      [
        "--model",
        "1",
        "--effort",
        "2",
        "--verbosity",
        "0",
        "--iterations",
        "12",
        "--debug",
        "--copy",
        "--output",
        "/tmp/out.txt",
        "質問",
      ],
      defaults,
      command,
    );
    expect(options.model).toBe(defaults.modelMini);
    expect(options.effort).toBe("high");
    expect(options.verbosity).toBe("low");
    expect(options.debug).toBe(true);
    expect(options.copyOutput).toBe(true);
    expect(options.copyExplicit).toBe(true);
    expect(options.finalOutputPath).toBe("/tmp/out.txt");
    expect(options.finalOutputExplicit).toBe(true);
    expect(options.maxIterations).toBe(12);
    expect(options.maxIterationsExplicit).toBe(true);
    expect(options.args).toEqual(["質問"]);
  });

  it("履歴系フラグを正しく解析して listOnly/index を割り当てる", () => {
    const defaults = createDefaults();
    const command = buildCommand({ defaults });
    const { options } = parseCommonOptions(
      ["--continue-conversation", "--resume", "5", "--delete", "3", "--show"],
      defaults,
      command,
    );
    expect(options.continueConversation).toBe(true);
    expect(options.resumeIndex).toBe(5);
    expect(options.hasExplicitHistory).toBe(true);
    expect(options.deleteIndex).toBe(3);
    expect(options.showIndex).toBeUndefined();
    expect(options.resumeListOnly).toBe(true);
  });

  it("compact 指定時に operation を compact に切り替える", () => {
    const defaults = createDefaults();
    const command = buildCommand({ defaults });
    const { options } = parseCommonOptions(["--compact", "3"], defaults, command);
    expect(options.operation).toBe("compact");
    expect(options.compactIndex).toBe(3);
  });

  it("help 表示時に helpRequested を true にする", () => {
    const defaults = createDefaults();
    const command = buildCommand({ defaults });
    const result = parseCommonOptions(["--help"], defaults, command);
    expect(result.helpRequested).toBe(true);
    expect(result.options.helpRequested).toBe(true);
  });

  it("--iterations を指定しない場合は既定値と false を返す", () => {
    const defaults = createDefaults();
    const command = buildCommand({ defaults });
    const { options } = parseCommonOptions([], defaults, command);
    expect(options.maxIterations).toBe(defaults.maxIterations);
    expect(options.maxIterationsExplicit).toBe(false);
  });

  it("--iterations を指定すると maxIterations と maxIterationsExplicit を更新する", () => {
    const defaults = createDefaults();
    const command = buildCommand({ defaults });
    const { options } = parseCommonOptions(["--iterations", "5"], defaults, command);
    expect(options.maxIterations).toBe(5);
    expect(options.maxIterationsExplicit).toBe(true);
  });
});

describe("expandLegacyShortFlags integration", () => {
  it("短縮フラグの展開結果が parseCommonOptions に渡される", () => {
    const defaults = createDefaults();
    const command = buildCommand({ defaults });
    const { options } = parseCommonOptions(["-m1e2v0", "-c", "-r5"], defaults, command);
    expect(options.model).toBe(defaults.modelMini);
    expect(options.effort).toBe("high");
    expect(options.verbosity).toBe("low");
    expect(options.continueConversation).toBe(true);
    expect(options.resumeIndex).toBe(5);
  });
});
