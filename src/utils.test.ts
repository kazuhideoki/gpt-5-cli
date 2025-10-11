import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetLogStyleCacheForTest,
  __setLogStyleForTest,
  decorateLevelValue,
  formatModelValue,
  formatScaleValue,
  levelForModelValue,
  levelForScaleValue,
} from "./utils.js";

const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
  process.env.NO_COLOR = originalNoColor;
  __resetLogStyleCacheForTest();
});

afterEach(() => {
  process.env.NO_COLOR = originalNoColor;
  __resetLogStyleCacheForTest();
});

describe("levelForScaleValue", () => {
  it("正規化してレベルを返す", () => {
    expect(levelForScaleValue("LOW")).toBe("low");
    expect(levelForScaleValue("Medium")).toBe("medium");
    expect(levelForScaleValue("hIgH")).toBe("high");
  });

  it("未知の値は high と判定する", () => {
    expect(levelForScaleValue("something")).toBe("high");
  });
});

describe("levelForModelValue", () => {
  const main = "gpt-5";
  const mini = "gpt-5-mini";
  const nano = "gpt-5-nano";

  it("既定モデル名を正しくマッピングする", () => {
    expect(levelForModelValue(main, main, mini, nano)).toBe("high");
    expect(levelForModelValue(mini, main, mini, nano)).toBe("medium");
    expect(levelForModelValue(nano, main, mini, nano)).toBe("low");
  });

  it("名称からヒューリスティックでレベル推定する", () => {
    expect(levelForModelValue("my-nano", main, mini, nano)).toBe("low");
    expect(levelForModelValue("super-lite", main, mini, nano)).toBe("low");
    expect(levelForModelValue("legacy-mini", main, mini, nano)).toBe("medium");
    expect(levelForModelValue("custom-base", main, mini, nano)).toBe("medium");
    expect(levelForModelValue("enterprise-pro", main, mini, nano)).toBe("high");
  });
});

describe("decorateLevelValue", () => {
  it("スタイルがあれば medium/high の文字列を装飾する", () => {
    __setLogStyleForTest({ mediumPrefix: "<m>", highPrefix: "<h>", reset: "</>" });
    expect(decorateLevelValue("value", "low")).toBe("value");
    expect(decorateLevelValue("value", "medium")).toBe("<m>+value+</>");
    expect(decorateLevelValue("value", "high")).toBe("<h>!value!</>");
  });

  it("NO_COLOR 環境でも強調記号は残る", () => {
    process.env.NO_COLOR = "1";
    __resetLogStyleCacheForTest();
    expect(decorateLevelValue("value", "high")).toBe("!value!");
  });
});

describe("formatModelValue / formatScaleValue", () => {
  const main = "gpt-5";
  const mini = "gpt-5-mini";
  const nano = "gpt-5-nano";

  it("モデル値をスタイル付きで表示する", () => {
    __setLogStyleForTest({ mediumPrefix: "[m]", highPrefix: "[h]", reset: "[/]" });
    expect(formatModelValue(mini, main, mini, nano)).toBe("[m]+gpt-5-mini+[/]");
    expect(formatModelValue(main, main, mini, nano)).toBe("[h]!gpt-5![/]");
  });

  it("尺度値をスタイル付きで表示する", () => {
    __setLogStyleForTest({ mediumPrefix: "{m}", highPrefix: "{h}", reset: "{/}" });
    expect(formatScaleValue("medium")).toBe("{m}+medium+{/}");
    expect(formatScaleValue("high")).toBe("{h}!high!{/}");
    expect(formatScaleValue("low")).toBe("low");
  });

  it("NO_COLOR 環境でも記号は維持される", () => {
    process.env.NO_COLOR = "1";
    __resetLogStyleCacheForTest();
    expect(formatModelValue(main, main, mini, nano)).toBe("!gpt-5!");
    expect(formatScaleValue("medium")).toBe("+medium+");
  });
});
