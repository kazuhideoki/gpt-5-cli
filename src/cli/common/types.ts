/**
 * src/cli/common/types.ts
 * CLI モード間で共有する Commander 設定・解析ロジックに関する型定義群。
 * 実装詳細から型を分離し、TDD フローで最初に合意できる契約を提供する。
 */
import type { Command } from "commander";
import type { CliDefaults, CommonCliOptions, TaskMode } from "../../types.js";
export type { CliLoggerConfig } from "../../foundation/logger/types.js";

/**
 * 共通フラグ定義付き Command インスタンスを生成するための設定。
 * extraOptionRegistrars はモード固有のフラグを登録する際に使用する。
 */
export interface CommonCommandBuildOptions {
  defaults: CliDefaults;
  mode: TaskMode;
  argument: {
    tokens: string;
    description: string;
  };
  extraOptionRegistrars: Array<(program: Command) => void>;
}

/**
 * 共通フラグの解析関数が返す基礎オプション集合。
 */
export interface CommonCliParseResult {
  options: CommonCliOptions;
  helpRequested: boolean;
}
