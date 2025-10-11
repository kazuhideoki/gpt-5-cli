# CLI 分離計画（default / d2）

## 背景
- 現状は単一 CLI（`src/cli.ts` → `dist/cli.js`）に複数モードを抱えており、機能ごとの差分が読みづらい。
- default モードと d2 モードで依存関係・フラグ構成が異なり、保守コストとユーザー体験の両面で分離の必要性が高まっている。
- 将来的に SQL モードを追加する予定があり、今のうちに CLI の分割基盤を整えておきたい。

## 成果物
- default 用 CLI と d2 用 CLI を独立したエントリーポイントとしてビルド・配布できる状態。
- 共通ロジック（設定、OpenAI クライアント、履歴管理など）を `src/core/` へ集約したアーキテクチャ。
- history 共通スキーマを維持しつつ、モード固有の `task.mode` 情報を拡張可能な構造。
- 既存の `bun run start` 相当の操作を default CLI で裏互換提供。
- CLI ごとの統合テストを個別に実行できる体制（default CLI 用・d2 CLI 用のスモーク/回帰テスト）。

## 実現方針
1. **ディレクトリ構成変更**
   - `src/cli/default.ts`, `src/cli/d2.ts` を作成。
   - 共通基盤を `src/core/` 以下へ分割（例：`config.ts`, `history.ts`, `openai.ts`, `runner.ts`）。
   - 業務ロジックを `src/commands/` に集約し、CLI から再利用できるユースケース単位の関数として実装。
   - CLI 層は引数パース・入出力整形・終了コード制御を主責務とし、それ以外は `commands`/`core` に委譲。
2. **ビルド・エントリーポイント調整**
   - `tsconfig.json` と `package.json` の `bin` / `scripts` を複数エントリに対応させる。
   - `bun run build` で `dist/default.js`, `dist/d2.js` が生成されるよう `esbuild`／`tsc` 設定を更新。
3. **既存機能の移植**
   - default 版：現 `src/cli.ts` の既存処理を移植し、既存コマンドと互換を保つ。
   - d2 版：`d2` 固有の初期化を `src/cli/d2.ts` にまとめ、不要な分岐を削除。
4. **履歴と設定の共通化**
   - `history_index.json` のスキーマ定義を `src/core/history.ts` に集約。
   - `.env` 読み込みやデフォルト値を `src/core/config.ts` で一元管理。
5. **テストとドキュメント**
   - `tests/` 配下に CLI 2 種のスモークテストを追加。
   - `README.md` と `plan*.md` を新構成へ更新。
   - 統合テストは CLI ごとにサブディレクトリを分け、`tests/default/` と `tests/d2/` で管理。

## 既知の課題・検討事項
- default / d2 以外のモード（SQL）は後続タスクで対応。共通基盤が拡張しやすい設計を意識する。
- CLI 分割後のインストール／実行手順が増えるため、バージョン切り替え時の周知方法を検討。
- `dist/cli.js` を利用している既存スクリプトとの互換性をどこまで維持するか要判断（暫定でラッパーを残す可能性あり）。

## ディレクトリ構成案
- `src/core/`: 共通インフラ層（設定、履歴スキーマ、OpenAI クライアント等）
- `src/commands/`: 業務ロジック層（会話開始、d2 レンダリング等のユースケース処理）
- `src/cli/default.ts`: default CLI エントリーポイント
- `src/cli/d2.ts`: d2 CLI エントリーポイント
- `dist/default.js`, `dist/d2.js`: ビルド成果物
- `tests/default/`: default CLI の統合テスト
- `tests/d2/`: d2 CLI の統合テスト
