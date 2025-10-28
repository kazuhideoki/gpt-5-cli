/**
 * paths.ts の環境変数依存挙動を TDD で定義するテストスケルトン。
 */
import { describe, it } from "vitest";

describe("expandHome", () => {
  it.todo("ConfigEnv の HOME を優先して展開する");

  it.todo("ConfigEnv に HOME が無い場合は OS 既定を利用する");
});
