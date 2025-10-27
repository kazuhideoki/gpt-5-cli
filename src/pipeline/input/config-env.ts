/**
 * CLI 実行時に利用する環境変数の読み込み契約を定義するモジュール。
 * `.env` 系ファイルを解決して内部状態として保持するクラス実装は別途提供する。
 */
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { ROOT_DIR } from "../../foundation/paths.js";

/**
 * ConfigEnv が認識する環境変数キーを列挙するリスト。
 * 実際にアプリケーション層で参照されるキーのみを対象にする。
 */
export const CONFIG_ENV_KNOWN_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL_MAIN",
  "OPENAI_MODEL_MINI",
  "OPENAI_MODEL_NANO",
  "OPENAI_DEFAULT_EFFORT",
  "OPENAI_DEFAULT_VERBOSITY",
  "GPT_5_CLI_PROMPTS_DIR",
  "GPT_5_CLI_MAX_ITERATIONS",
  "GPT_5_CLI_HISTORY_INDEX_FILE",
  "GPT_5_CLI_OUTPUT_DIR",
  "SQRUFF_BIN",
  "NO_COLOR",
] as const;

/** ConfigEnv が扱う環境変数キーのユニオン型。 */
export type ConfigEnvKey = (typeof CONFIG_ENV_KNOWN_KEYS)[number];

/**
 * ConfigEnv で提供する環境変数の値マップ。
 * 未指定が許容されるキーは `undefined` を含める（利用側で存在確認を要求するため）。
 */
export interface ConfigEnvValueMap {
  /** API クライアントで必須となる OpenAI の API キー。 */
  readonly OPENAI_API_KEY: string | undefined;
  /** メインモデル指定は任意のため未設定を許容する。 */
  readonly OPENAI_MODEL_MAIN: string | undefined;
  /** 軽量モデル指定は任意のため未設定を許容する。 */
  readonly OPENAI_MODEL_MINI: string | undefined;
  /** ナノモデル指定は任意のため未設定を許容する。 */
  readonly OPENAI_MODEL_NANO: string | undefined;
  /** 既定 effort は省略可能なので `undefined` を許容する。 */
  readonly OPENAI_DEFAULT_EFFORT: string | undefined;
  /** 既定 verbosity も省略可能なので `undefined` を許容する。 */
  readonly OPENAI_DEFAULT_VERBOSITY: string | undefined;
  /** プロンプトディレクトリは外部設定が任意のため未設定を許容する。 */
  readonly GPT_5_CLI_PROMPTS_DIR: string | undefined;
  /** 反復上限は環境で省略可能なため未設定を許容する。 */
  readonly GPT_5_CLI_MAX_ITERATIONS: string | undefined;
  /** 履歴パスは環境で指定される想定だがテスト環境で未設定があり得るため許容する。 */
  readonly GPT_5_CLI_HISTORY_INDEX_FILE: string | undefined;
  /** 出力ディレクトリ指定はオプションのため未設定を許容する。 */
  readonly GPT_5_CLI_OUTPUT_DIR: string | undefined;
  /** SQL フォーマッタのバイナリ指定は任意のため未設定を許容する。 */
  readonly SQRUFF_BIN: string | undefined;
  /** NO_COLOR はフラグ用途で省略可能なため未設定を許容する。 */
  readonly NO_COLOR: string | undefined;
}

/** ConfigEnv が提供するエントリ配列の型。 */
export type ConfigEnvEntries = ReadonlyArray<readonly [ConfigEnvKey, string]>;

/** `.env` 群の読み込み挙動を調整する初期化オプション。 */
export interface ConfigEnvInitOptions {
  /**
   * CLI モードごとに `.env.{suffix}` を選択的に適用するための接尾辞。
   * モードによっては追加ファイルが存在しないケースがあるため optional 指定。
   */
  readonly envSuffix?: string;
  /**
   * デフォルトではリポジトリルートを探索対象とするが、テストで仮想ディレクトリを
   * 指定できるようにするためのルートパス。通常運用では省略されるため optional。
   */
  readonly baseDir?: string;
}

/**
 * `ConfigEnv` が満たすべき読み取り操作の契約。
 * 実装は `.env` 群から構築した値を利用して各メソッドを提供する。
 */
export interface ConfigEnvContract {
  /**
   * 指定したキーの値を返す。未定義の場合は undefined。
   *
   * @param key 参照する環境変数名。
   */
  get(key: string): string | undefined;

  /**
   * 指定したキーが保持されているかどうかを判定する。
   *
   * @param key 存在確認を行う環境変数名。
   */
  has(key: string): boolean;

  /**
   * 保持している全てのキーと値の組を列挙する。
   *
   * @returns イテレータで表現したキーと値のペア。
   */
  entries(): IterableIterator<[key: string, value: string]>;
}

/**
 * `.env` 群から読み込んだ環境変数を内部に保持し、参照専用で提供する実装。
 * インスタンス生成時にすべてのファイルを読み込む前提とし、以降は不変とする。
 */
export class ConfigEnv implements ConfigEnvContract {
  /** 設定値を保持する Map。 */
  private readonly values: Map<string, string>;

  private constructor(values: Map<string, string>) {
    this.values = values;
  }

  /**
   * `.env` ファイル群を読み込んで ConfigEnv インスタンスを生成する。
   *
   * @param options 読み込み挙動を制御するためのオプション。
   * @returns 構築済みの ConfigEnv。
   */
  static async create(options: ConfigEnvInitOptions = {}): Promise<ConfigEnv> {
    const baseDir = options.baseDir ?? ROOT_DIR;
    const initialValues = new Map<string, string>();
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") {
        initialValues.set(key, value);
      }
    }
    const resolvedValues = new Map(initialValues);

    const baseEnvPath = path.join(baseDir, ".env");
    const baseEntries = await parseEnvFile(baseEnvPath);
    const baseValueMap = new Map(baseEntries ?? []);
    if (baseEntries !== null) {
      for (const [key, value] of baseEntries) {
        if (!initialValues.has(key)) {
          resolvedValues.set(key, value);
        }
      }
    }

    const suffix = options.envSuffix?.trim();
    if (suffix && suffix.length > 0) {
      const overrideEnvPath = path.join(baseDir, `.env.${suffix}`);
      const overrideEntries = await parseEnvFile(overrideEnvPath);
      if (overrideEntries !== null) {
        for (const [key, value] of overrideEntries) {
          if (!initialValues.has(key)) {
            resolvedValues.set(key, value);
            continue;
          }
          const baseValue = baseValueMap.get(key);
          if (baseValue !== undefined && initialValues.get(key) === baseValue) {
            resolvedValues.set(key, value);
          }
        }
      }
    }

    return new ConfigEnv(resolvedValues);
  }

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  entries(): IterableIterator<[key: string, value: string]> {
    return this.values.entries();
  }
}

/**
 * 指定されたファイルパスに存在する `.env` ファイルを解析し、キーと値のペアを返す。
 *
 * @param filePath 読み込む `.env` ファイルの絶対パス。
 * @returns 解析結果のエントリ配列。ファイルが存在しない場合は null。
 */
async function parseEnvFile(
  filePath: string,
): Promise<ReadonlyArray<[key: string, value: string]> | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = dotenv.parse(content);
    return Object.entries(parsed);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * ENOENT などファイルが存在しない場合に発生するエラーかどうかを判定する。
 *
 * @param error 判定対象のエラー。
 * @returns 指定のエラーがファイル未存在を示す場合は true。
 */
function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  if (error && typeof error === "object" && "code" in error) {
    const errno = (error as Partial<NodeJS.ErrnoException>).code;
    return errno === "ENOENT";
  }
  return false;
}
