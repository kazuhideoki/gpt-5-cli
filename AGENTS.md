# Codex Agent Playbook — gpt-5-cli

## 1. 役割と目的

- **あなたの役割**: `gpt-5-cli` の開発・保守を支援する開発エージェント。
- **目的**: 既存設計を守りながら、コード・ドキュメント・テスト・PR を安全に更新すること。
- **言語**: 最終的なユーザー向けの回答は **日本語** で出力すること。

## 2. リポジトリ構成

以下は本リポジトリの構造と責務です。**推測せず**、必要に応じて該当ファイルを開いて確認してから編集してください。

- `src/cli/` … `default`・`d2`・`mermaid`・`sql` 各モードのエントリーポイント群と共通ランタイム `runtime/` を束ねる。`runtime/` は CLI 初期化・入力分岐などの共通処理。
- `src/session/` … Responses API を使うチャットセッションの **サービス層**。履歴同期とツール実行のオーケストレーションを担う。Agents SDK 用の `agent-session.ts` もここに並列配置されている。
- `src/core/` … CLI から利用される **ドメインロジック層**。モジュール同士は `types.ts` の型以外への依存を持たない。サービス層（`src/session/` や `src/cli/`）から横並びで組み合わせる設計。
  - `config.ts` … 設定の読込・検証と API キー解決（`resolveOpenAIApiKey`）。**他 core モジュールに依存しない**。
  - `tools.ts` … 関数ツール定義とランタイム生成。Responses API 用ツール配列 `buildCliToolList` を提供。
  - `options.ts` / `formatting.ts` / `prompts.ts` / `history.ts` … `types.ts` のみ参照する純ユーティリティ。

**ビルド/開発コマンド**（よく使う順）

- `bun run dev`（ask CLI を TS ソースから起動）
- `bun run dev:d2` / `bun run dev:mermaid` / `bun run dev:sql`
- `bun run build`（TS を `dist/` にコンパイル）
- `bun run start -- --help`（ビルド済み ask CLI のヘルプ）
- `GPT_5_CLI_HISTORY_INDEX_FILE=/tmp/history.json NO_COLOR=1 bun run start -- -r`（履歴機能の安定出力を検証）

## 3. 行動規範

**R1. 型・モジュール方針**

- TypeScript は `strict` で、ESM（`type: module`）。
- インデントは 2 スペース。暗黙の `any` は禁止。
- ファイル先頭に概要/責務コメントを置く。関数・主要モジュールには **JSDoc** を付与。型はコメントではなく **TypeScript の型定義**で表す。
- 名前は役割が伝わる **英語** を用いる。CLI フラグ特に指示がなけれは **短縮形 + ロングオプション** をペアで用意。

**R2. スキーマ/検証**

- 可能な限り **`zod`** を使用。ランタイム整合性とエラーメッセージを統一する。
- `zod` で定義したスキーマは **`z.infer`** で型共有し、同じ構造を手書きの `type/interface` と **二重管理しない**。
- 既定値はマジックナンバー化せず定数化する。

**R3. 公開面の最小化**

- 外部から使わない型・スキーマ・ヘルパーは **`export` しない**。同一ファイルで閉じる。

**R4. 参照規律（Biome で強制）**

- `core` から `@session/*`・`@cli/*`・相対 `../**/session/**`・`../**/cli/**` への import を禁止。
- `session` から `@cli/*`・相対 `../**/cli/**` への import を禁止。
- 例外設定は設けない（`biome.json` の `overrides` で強制）。

**R5. ログ/出力**

- ログは **`console.error`**、ユーザー向けメッセージは **`console.log` または `process.stdout.write`**。

**R6. 失敗の扱い**

- 個人用スクリプト運用を前提に **フォールバック不要**。入力検証で異常を検知したら **即座に例外** を投げ早期失敗とする。
- メソッド/コードパスは **最小限実装で可**。追加要件時に拡張。**後方互換は不要**。

**R7. 回答スタイル**

- 最終回答は **日本語**。ユーザー向けメッセージでは必要以上に専門用語を増やさない。

## 4. 開発フロー

**毎回この順に実行・合格してから PR**：

1. `bun run build` で型エラーがないこと。
2. `bun run knip:exports` で未使用 export がないことを確認。必要に応じて `bun run knip:fix-exports` を実行する。
3. `bun run lint` と `bun run format:check` を実行し、差分/エラーがないこと。
4. `bun run test` の全テスト成功。
5. 履歴関連変更がある場合：上記 `-r` 例コマンドで出力差分を目視確認し、`jq . history_index.json` で JSON 整合性確認。
6. 新機能や変更では、対象モジュールと **同じ階層に `*.test.ts`** を追加。`tests/` には **統合テストのみ** を置く。
7. 設計/メソッドを変更した場合、**依存モジュールのテストも更新** されていることを確認。
8. 実装は小さく刻み、PR では再現手順と確認コマンドを具体的に記載する。

## 5. コミットと PR ガイドライン

- **Commit**: Conventional Commits に従う（例: `feat(cli): ...`, `fix(history): ...`）。
- **PR 内容**: 背景 / 実装概要 / 影響範囲 / 手動確認手順 / 関連 Issue を記載。フラグ変更時は **`README.md` と CLI ヘルプを同期**。
- **検証証跡**: `bun run build` の結果や対話ログの抜粋など、**検証証跡** を PR に添付。

## 6. 作業ツール

- 可能なら **`mcp__serena`** を使って作業する。

## 7. タスク計画

- タスクの詳細は **`plan*.md`** を参照する。
