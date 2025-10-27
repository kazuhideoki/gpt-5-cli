/**
 * CLI 実行時に利用する環境変数の読み込み契約を定義するモジュール。
 * `.env` 系ファイルを解決して内部状態として保持するクラス実装は別途提供する。
 */
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { ROOT_DIR } from "../../foundation/paths.js";

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
