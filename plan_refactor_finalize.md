# finalize 層リファクタリング計画（2025-10-20案）

## 目的とゴール
- `src/pipeline/finalize` に結果処理の責務を集約し、CLI 層から重複ロジックを排除する。
- `handleResult` をエントリーポイントとして、標準出力・ファイル保存・クリップボード・履歴更新・終了コード決定を一元管理する。
- `performCompact` を含む「履歴関連の副作用」を finalize 層へ寄せ、process 層はリクエスト実行専念の構造に近づける。

## ステークホルダー
- CLI 各モード (`ask` / `d2` / `mermaid` / `sql`) の結果処理呼び出し部分。
- `src/pipeline/finalize/io.ts`（ファイル・コピー周りのユーティリティ）。
- `src/pipeline/history/store.ts`（履歴保存 API）。
- `src/pipeline/process/responses.ts` の `performCompact`。

## リファクタリング方針
1. `handleResult` を `src/pipeline/finalize` の公的エクスポートとして定義し、以下の契約をまとめる:
   - 入力（`InputDescriptor[]`）と処理結果（`ProcessResult`）を受け取り、`FinalizeOutcome` を返す。
   - `FinalizeOutcome` は `exitCode`, `stdout`, `logs`, `outputArtifacts`, `historyContext` 等を保持。
   - CLI 層は戻り値に従って `process.stdout` / `process.stderr` に書き込むのみ。
2. CLI 固有の履歴拡張は `FinalizeHooks` または `FinalizeTaskConfig` の形で `handleResult` に渡す。
   - 例: D2/Mermaid の `file_path`・`copySource` 等はフックで組み立て、`handleResult` が `HistoryStore` に渡す。
3. `deliverOutput` / `generateDefaultOutputPath` は `handleResult` 内で利用し、CLI から直接呼ばない。
   - HOME 展開やワークスペース境界チェックは foundation の `paths.ts` へ統一。
4. `performCompact` は結果テキストを返すだけに縮め、履歴更新・出力は `handleResult` (もしくは共通 finalize ヘルパー) に委譲する。

## 実施手順案
1. **契約定義**
   - `src/pipeline/finalize` に `types.ts`（`FinalizeRequest` / `FinalizeOutcome` / `FinalizeHooks` 等）を追加。
   - `handleResult` の骨格を `finalize/index.ts` などに作成し、既存 `io.ts` をインポート。
2. **ユーティリティ整理**
   - `expandHomeDirectory` を `foundation/paths.ts` の `expandHome` へ寄せる or 置換。
   - `ensureWorkspacePath` を共通化する（必要なら foundation に移動）。
3. **CLI からの移行（段階的）**
   - `ask` CLI で `deliverOutput`・履歴更新・stdout 書き出しを `handleResult` 経由へ移行。
   - 動作確認後、`d2` → `mermaid` → `sql` の順で同様に移行し、フックが必要な差分を整理。
4. **`performCompact` 移行**
   - compact 実行で `ProcessResult` 相当の構造体を返すよう変更。
   - CLI 側は `handleResult` を使って出力・履歴保存を完了させる。
5. **テスト整備**
   - `src/pipeline/finalize/handle-result.test.ts`（仮）を追加し、代表的なモードの分岐・履歴更新・コピー指定を検証。
   - 既存 `io.test.ts` はユーティリティテストとして維持。
6. **最終調整**
   - CLI ファイル内の TODO を更新。
   - `plan_refactor.md` の finalize 項目を最新状態に合わせて更新。
   - `bun run build` ほか標準コマンドでリグレッション確認。

## リスクと留意点
- CLI 固有の履歴コンテキスト構造を finalize 層へ押し込みすぎると柔軟性が下がるため、モード別フック設計を先に決める。
- `deliverOutput` を複数回呼んでいたケース（サマリー＋成果物など）が無いか確認する。
- Compact 経路の例外処理や exit code を統一する際に既存挙動の差分が出ないよう、先にベースラインをテストで確保する。

