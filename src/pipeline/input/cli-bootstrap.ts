// cli-bootstrap.ts: 各 CLI で共通となる初期化と履歴ストア準備をまとめたユーティリティ。
// NOTE(pipeline/input): 将来的には Input パイプラインのエントリポイントから呼び出す想定。
import type { HistoryEntry } from "../history/store.js";
import { HistoryStore } from "../history/store.js";
import { loadDefaults, loadEnvironment } from "./config.js";
import { loadPrompt, resolvePromptPath } from "./prompts.js";
import type { CliDefaults, CliOptions, ConfigEnvironment } from "../../types.js";
import type { z } from "zod";
import type { ConfigEnvInitOptions } from "./config-env.js";

/**
 * `bootstrapCli` に供給する CLI 初期化パラメータ群。
 * @typeParam TOptions - CLI 固有オプションの構造。
 * @typeParam THistoryContext - 履歴ストアに格納する文脈型。
 */
interface CliBootstrapParams<TOptions extends CliOptions, THistoryContext> {
  /**プロセス引数列。CLI 入口の入力そのものを渡す。*/
  argv: string[];
  /**ログ出力に用いる CLI 名。識別しやすくするため必須。*/
  logLabel: string;
  /**引数解析関数。既定値を考慮しつつ CLI 固有のオプション型へ変換する。*/
  parseArgs: (argv: string[], defaults: CliDefaults, configEnv: ConfigEnvironment) => TOptions;
  /**履歴ストア文脈の検証スキーマ。実行時整合性を保証するため必須。*/
  historyContextSchema: z.ZodType<THistoryContext>;
  /**特定履歴のみを対象にしたい CLI で利用するフィルタ。全履歴を扱う場合は不要なためオプショナル。*/
  historyEntryFilter?: (entry: HistoryEntry<THistoryContext>) => boolean;
  /**環境ファイルのサフィックス。追加環境設定が不要な CLI もあるため省略可。*/
  envFileSuffix?: string;
  /**ConfigEnv 初期化挙動を上書きするためのオプション。テストなどで利用する。*/
  configEnvOptions?: Omit<ConfigEnvInitOptions, "envSuffix">;
}

/**
 * `--help` 処理を完了した場合に返される結果。
 * @typeParam TOptions - CLI 固有オプションの構造。
 */
interface CliBootstrapHelpResult<TOptions extends CliOptions> {
  /**CLI がヘルプ表示モードで終了したことを示す識別子。*/
  status: "help";
  /**ロードされた既定値群。ヘルプ描画でも提示するため保持。*/
  defaults: CliDefaults;
  /**解析済みオプション。ヘルプ出力の文脈共有に用いる。*/
  options: TOptions;
  /**読み込まれたシステムプロンプト。ファイルが無い場合は存在しないためオプショナル。*/
  systemPrompt?: string;
  /**システムプロンプトの解決パス。*/
  promptPath: string;
  /**読み込んだ ConfigEnv。後続処理へ引き渡す。*/
  configEnv: ConfigEnvironment;
}

/**
 * CLI 実行を継続できる状態で返される結果。
 * @typeParam TOptions - CLI 固有オプションの構造。
 * @typeParam THistoryContext - 履歴ストアに格納する文脈型。
 */
interface CliBootstrapReadyResult<TOptions extends CliOptions, THistoryContext> {
  /**CLI が実行継続可能な状態であることを示す識別子。*/
  status: "ready";
  /**ロード済みの既定値群。*/
  defaults: CliDefaults;
  /**解析済みオプション。以降の処理に渡される。*/
  options: TOptions;
  /**読み込まれたシステムプロンプト。ファイル未配置の場合は存在しないためオプショナル。*/
  systemPrompt?: string;
  /**システムプロンプトの解決パス。*/
  promptPath: string;
  /**履歴ストアインスタンス。文脈検証済みの状態で返す。*/
  historyStore: HistoryStore<THistoryContext>;
  /**読み込んだ ConfigEnv。後続処理へ引き渡す。*/
  configEnv: ConfigEnvironment;
}

/**
 * `bootstrapCli` が返し得る結果の共用体。
 * @typeParam TOptions - CLI 固有オプションの構造。
 * @typeParam THistoryContext - 履歴ストアに格納する文脈型。
 */
type CliBootstrapResult<TOptions extends CliOptions, THistoryContext> =
  | CliBootstrapHelpResult<TOptions>
  | CliBootstrapReadyResult<TOptions, THistoryContext>;

/**
 * CLIエントリーポイントで共通となる初期化処理を実行する。
 */
export async function bootstrapCli<TOptions extends CliOptions, THistoryContext = unknown>(
  params: CliBootstrapParams<TOptions, THistoryContext>,
): Promise<CliBootstrapResult<TOptions, THistoryContext>> {
  const configEnv = await loadEnvironment({
    envSuffix: params.envFileSuffix,
    ...params.configEnvOptions,
  });
  const defaults = loadDefaults(configEnv);
  console.log(`${params.logLabel} history_index: ${defaults.historyIndexPath}`);

  const options = params.parseArgs(params.argv, defaults, configEnv);
  const promptPath = resolvePromptPath(options.taskMode, defaults.promptsDir);
  const systemPrompt = loadPrompt(options.taskMode, defaults.promptsDir);
  if (systemPrompt) {
    const bytes = Buffer.byteLength(systemPrompt, "utf8");
    console.log(`${params.logLabel} system_prompt: loaded (${bytes} bytes) path=${promptPath}`);
  } else {
    console.error(`${params.logLabel} system_prompt: not found or empty path=${promptPath}`);
  }

  if (options.helpRequested) {
    return {
      status: "help",
      defaults,
      options,
      systemPrompt,
      promptPath,
      configEnv,
    };
  }

  const historyStore = new HistoryStore<THistoryContext>(defaults.historyIndexPath, {
    contextSchema: params.historyContextSchema,
    entryFilter: params.historyEntryFilter,
  });

  return {
    status: "ready",
    defaults,
    options,
    systemPrompt,
    promptPath,
    historyStore,
    configEnv,
  };
}
