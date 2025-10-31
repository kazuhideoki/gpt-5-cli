/**
 * @file finalize 層が公開する契約型。結果処理まわりの入力・出力を定義する。
 */
import type { CliLogger } from "../../foundation/logger/types.js";
import type { ConfigEnvironment } from "../../types.js";
import type { CopySource, DeliverOutputParams, DeliverOutputResult } from "./io.js";

/**
 * finalize 層が扱うクリップボードコピーの入力構造。
 */
export interface FinalizeClipboardAction {
  kind: "clipboard";
  /** アクションの有効化に利用された CLI フラグ名。 */
  flag: string;
  /** コピー内容の取得元。 */
  source: FinalizeCopySource;
  /** ファイル参照時のワークスペースルートとなる作業ディレクトリ。 */
  workingDirectory: string;
  /** 実行順序を決める優先順位。小さい値から順に実行する。 */
  priority: number;
}

/**
 * D2 成果物を HTML へ変換する finalize アクション。
 */
export interface FinalizeD2HtmlAction {
  kind: "d2-html";
  /** 変換元となる D2 ファイルの相対パス。 */
  sourcePath: string;
  /** 生成した HTML を保存する相対パス。 */
  htmlOutputPath: string;
  /** コマンド実行時の作業ディレクトリ。 */
  workingDirectory: string;
  /** 生成完了後に HTML をブラウザで開く場合に true。 */
  openHtml: boolean;
  /** 実行順序を決める優先順位。小さい値から順に実行する。 */
  priority: number;
}

/**
 * finalize 層で利用する後続アクションの判別共用体。
 */
export type FinalizeAction = FinalizeClipboardAction | FinalizeD2HtmlAction;

/**
 * finalize 層が受け取る後続アクションの配列。
 */
export type FinalizeActionList = FinalizeAction[];

/**
 * サマリ出力先を決定するために finalize 層へ渡される情報。
 */
export interface ResultOutputResolutionParams {
  /** ユーザーが --output を明示した場合に true。 */
  responseOutputExplicit: boolean;
  /** CLI 解析で得た出力パス。未指定時は undefined。 */
  responseOutputPath: string | undefined;
  /** 成果物ファイルの相対パス。 */
  artifactPath: string;
}

/**
 * finalize 層が CLI へ返すサマリ出力判定結果。
 */
export interface ResultOutputResolution {
  /** テキスト出力ファイルのパス。保存不要なら null。 */
  textOutputPath: string | null;
  /** 履歴や成果物参照に用いるパス。必ず提供される。 */
  artifactReferencePath: string;
}

export type FinalizeExitCode = 0 | 1;

export type FinalizeCopySource = CopySource;

export interface FinalizeDeliveryInstruction {
  /**
   * `deliverOutput` に与えるパラメータ。`content` が未指定の場合は `FinalizeRequest.content` を用いる。
   */
  params: Omit<DeliverOutputParams, "content"> & { content: string | undefined };
  /**
   * 出力先を差し替えたい場合に利用する任意のハンドラー。
   */
  handler: FinalizeDeliveryHandler | undefined;
}

export type FinalizeDeliveryHandler = (params: DeliverOutputParams) => Promise<DeliverOutputResult>;

export interface FinalizeHistoryEffect {
  /**
   * 履歴更新などの副作用を実行するコールバック。
   */
  run: () => void | Promise<void>;
}

export interface FinalizeRequest {
  /**
   * 結果本文。標準出力およびファイル出力の既定値として扱う。
   */
  content: string;
  /**
   * 終了後に実施するアクション配列。未実施の場合は空配列を渡す。
   */
  actions: FinalizeActionList;
  /**
   * finalize 層で環境値を参照するための ConfigEnv。
   */
  configEnv: ConfigEnvironment;
  /**
   * finalize 層で利用する CLI ロガー。
   */
  logger: CliLogger;
  /**
   * stdout へ書き出すテキストを明示的に指定したい場合に利用する。
   */
  stdout: string | undefined;
  /**
   * ファイル保存やクリップボードコピーなどの出力指示。
   */
  output: FinalizeDeliveryInstruction | undefined;
  /**
   * 履歴更新など任意の副作用。
   */
  history: FinalizeHistoryEffect | undefined;
  /**
   * finalize が返す終了コード。未指定時は 0。
   */
  exitCode: FinalizeExitCode | undefined;
}

export interface FinalizeOutcome {
  exitCode: FinalizeExitCode;
  stdout: string;
  output:
    | {
        filePath: string | undefined;
        bytesWritten: number | undefined;
        copied: boolean | undefined;
      }
    | undefined;
}
