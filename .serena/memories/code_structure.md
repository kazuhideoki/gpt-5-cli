# ディレクトリ構成メモ
- `src/cli/` — default・d2・sql 各 CLI 用のエントリーポイントと共通ユーティリティ (`shared/`)。
- `src/commands/` — CLI から呼び出すドメインサービス層。現在は会話処理ロジックを提供。
- `src/core/` — 設定読込・OpenAI クライアント生成・history/formatting 等の基盤ユーティリティ群。
- `dist/` — `bun run build` で生成されるバンドル済み CLI (`dist/cli/<mode>.js` など)。
- `docs/`, `plan.md` — プロジェクト計画と補助ドキュメント。
- `tests/` — 統合テスト。各 `src/` 階層には対応する単体テスト (`*.test.ts`) を配置。
- `.serena/` — エージェント用キャッシュとナレッジベース (`memories/`)。
- `.env.example` — 必要な環境変数のテンプレート。実行時の履歴出力先は `GPT_5_CLI_HISTORY_INDEX_FILE` で制御。
