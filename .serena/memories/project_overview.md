# プロジェクト概要
- OpenAI Responses API を包む TypeScript 製 CLI で、default と d2 の 2 つのモードを提供する。
- Bun で動作し、履歴管理やモデル選択、reasoning effort / verbosity 切り替え、画像入力、ログ要約 (`--compact`) をサポート。
- default CLI は `gpt-5-cli`, d2 CLI は `gpt-5-cli-d2` としてビルド後に利用可能。
- 主なエントリーポイントは `src/cli.ts`、ビルド後成果物は `dist/cli.js` 系列。履歴索引は `history_index.json` に保存される。
- `.env` に OpenAI 認証情報や既定値を設定し、共有値は `.env.example` を更新する。