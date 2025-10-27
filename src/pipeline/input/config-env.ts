/**
 * CLI 実行時に利用する環境変数の読み込み契約を定義するモジュール。
 * `.env` 系ファイルを解決して内部状態として保持するクラス実装は別途提供する。
 */

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
