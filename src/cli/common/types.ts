/**
 * src/cli/common/types.ts
 * CLI モード間で共有する Commander 設定・解析ロジックに関する型定義群。
 * 実装詳細から型を分離し、TDD フローで最初に合意できる契約を提供する。
 */
import type { Command } from "commander";
import type { CliDefaults, CommonCliOptions, TaskMode } from "../../types.js";
import type { EffortLevel, VerbosityLevel } from "../../types.js";
import type { CliLogger } from "../../foundation/logger/types.js";

/**
 * Commander に共通引数を登録する際のコールバック。
 * mode 固有の追加オプションはこの型を使ってプラグインする想定。
 */
export type CommanderOptionRegistrar = (program: Command) => void;

/**
 * Commander の input 引数（例: `[input...]`）を記述するための定義。
 */
export interface CommandArgumentDescriptor {
  tokens: string;
  description: string;
}

/**
 * 共通フラグ定義付き Command インスタンスを生成するための設定。
 * extraOptionRegistrars はモード固有のフラグを登録する際に使用する。
 */
export interface CommonCommandBuildOptions {
  defaults: CliDefaults;
  mode: TaskMode;
  argument: CommandArgumentDescriptor;
  extraOptionRegistrars: CommanderOptionRegistrar[];
}

/**
 * CLI 実装で共有するロガー依存性を表す。
 * Winston 依存を直接晒さず、依存注入する契約を固定する。
 */
export interface CliLoggerConfig {
  /** CLI で利用する Winston ベースのロガー。 */
  logger: CliLogger;
  /** 既存メッセージと互換性を保つためのラベル。 */
  logLabel: string;
  /** デバッグ出力を有効化するか。 */
  debugEnabled: boolean;
}

/**
 * Commander#opts() から得られる共通フラグの生値を表現する。
 * CLI では各フラグが省略可能であるため optional を伴う。
 */
export interface RawCommonFlagValues {
  model?: string;
  effort?: EffortLevel;
  verbosity?: VerbosityLevel;
  continueConversation?: boolean;
  resume?: string | boolean;
  delete?: string | boolean;
  show?: string | boolean;
  debug?: boolean;
  image?: string;
  output?: string;
  copy?: boolean;
  compact?: number;
}

/**
 * Commander#getOptionValueSource を boolean 化して保持するスナップショット。
 */
export interface CommonOptionSourceSnapshot {
  modelExplicit: boolean;
  effortExplicit: boolean;
  verbosityExplicit: boolean;
  responseOutputExplicit: boolean;
  copyExplicit: boolean;
}

/**
 * 共通フラグの解析関数が返す基礎オプション集合。
 */
export interface CommonCliParseResult {
  options: CommonCliOptions;
  helpRequested: boolean;
}

/**
 * 共通フラグ解析時に必要となる Commander 依存関係をまとめた入力。
 */
export interface CommonParseDependencies {
  argv: string[];
  defaults: CliDefaults;
  mode: TaskMode;
  program: Command;
}
