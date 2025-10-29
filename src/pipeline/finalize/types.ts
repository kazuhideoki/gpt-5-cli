/**
 * @file finalize 層が公開する契約型。結果処理まわりの入力・出力を定義する。
 */
import type { ConfigEnvironment } from "../../types.js";
import type { CopySource, DeliverOutputParams, DeliverOutputResult } from "./io.js";

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
   * finalize 層で環境値を参照するための ConfigEnv。
   */
  configEnv: ConfigEnvironment;
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
  output: {
    filePath: string | undefined;
    bytesWritten: number | undefined;
    copied: boolean | undefined;
  } | undefined;
}
