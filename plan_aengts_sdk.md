# Agents SDK 導入設計概要

## 背景と目的
- d2 / mermaid / sql CLI は Responses API を直接叩き、自前でエージェントループとツール呼び出しを制御している。
- OpenAI Agents SDK を使うことで、エージェントループ・再実行制御を SDK に委譲し、CLI 実装を簡素化する。
- 履歴の詳細保持や後方互換性は優先度が低い。まずは動作する最小構成を作り、必要に応じて拡張する方針とする。

## 導入方針（最小実装）
1. `@openai/agents` を依存に追加し、TypeScript で利用できるよう設定する。
2. `src/session/agent-session.ts`（新規）を追加し、Agents SDK の `Agent` 定義と `run` 呼び出しをカプセル化する。
   - 既存の `createOpenAIClient` に準じて API キー解決のみを依存させる。
   - ツール実行は `src/core/tools.ts` の `ToolRegistration` を使い、Agents SDK 形式へ変換するアダプタ関数を用意する。
   - 実行結果として最終応答テキストと必要なメタ情報のみ返す。
3. CLI 層（例: `src/cli/d2.ts`）では `chat-session.ts` ではなく新しいエージェントセッション実装を呼び出し、レスポンスをそのまま既存の出力・ファイル保存ロジックへ渡す。
4. 履歴は現行の `HistoryStore` を継続利用し、エージェント実行完了後に最終応答を保存するだけのシンプルな形から開始する。
   - 詳細なツール呼び出しログや Agent Session ID の保持は後続タスクで検討。

## 想定モジュール構成
- `src/session/agent-session.ts`
  - `runAgentConversation(options, historyStore, toolRuntime)`（仮）を提供。
  - Agents SDK の `Agent`／`Session` 初期化と `run()` のラッパー。
- `src/core/tools.ts`
  - `createAgentsToolList(registrations)` のようなアダプタ関数を追加し、既存ツール定義を流用。
- `src/cli/d2.ts` 他
  - `executeWithTools` 呼び出しを新モジュールへ置き換える。
  - `HistoryStore` 連携は既存ロジックを流用。

## 段階的進め方
1. d2 CLI を対象に PoC 実装を作成し、Agents SDK が想定通り動作することを確認する。
2. 問題なければ mermaid / sql CLI へ横展開する。
3. 必要に応じて Agents SDK の `Session` API を追加利用し、履歴同期やメタ情報の保存方法を再検討する。

## 留意点
- Agents SDK のバージョンと `openai` SDK の共存状況を確認し、重複依存によるバンドル増大に注意する。
- CLI 固有の環境変数・フラグ仕様を維持するため、エージェント実行前後で適切にログ出力やファイル操作を行う。
- PoC 段階では履歴破壊的変更を許容するが、必要になった場合に備えて最終応答以外のメタデータも取得しやすい構造を残しておく。
