// create-cli-logger.test.ts: createCliLogger の仕様テスト。
import { describe, it } from "bun:test";

describe("createCliLogger", () => {
  it("debug フラグが false の場合は info レベルで初期化する");
  it("debug フラグが true の場合は debug レベルで初期化する");
  it("ラベル付きフォーマットでログを出力する");
  it("モード情報をメタデータとして保持する");
});
