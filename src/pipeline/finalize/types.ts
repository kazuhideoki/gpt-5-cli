/**
 * @file finalize 層が公開する契約型。結果処理まわりの入力・出力を定義する。
 */
import type { CopySource, DeliverOutputParams, DeliverOutputResult } from "./io.js";

export type FinalizeExitCode = 0 | 1;

export type FinalizeCopySource = CopySource;

export interface FinalizeDeliveryInstruction {
  /**
   * `deliverOutput` に与えるパラメータ。`content` が未指定の場合は `FinalizeRequest.content` を用いる。
   */
  params: Omit<DeliverOutputParams, "content"> & { content?: string };
  /**
   * 出力先を差し替えたい場合に利用する任意のハンドラー。
   */
  handler?: FinalizeDeliveryHandler;
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
   * stdout へ書き出すテキストを明示的に指定したい場合に利用する。
   */
  stdout?: string;
  /**
   * ファイル保存やクリップボードコピーなどの出力指示。
   */
  output?: FinalizeDeliveryInstruction;
  /**
   * 履歴更新など任意の副作用。
   */
  history?: FinalizeHistoryEffect;
  /**
   * finalize が返す終了コード。未指定時は 0。
   */
  exitCode?: FinalizeExitCode;
}

export interface FinalizeOutcome {
  exitCode: FinalizeExitCode;
  stdout: string;
  output?: {
    filePath?: string;
    bytesWritten?: number;
    copied?: boolean;
  };
}
