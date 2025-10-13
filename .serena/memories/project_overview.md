# プロジェクト概要
- OpenAI Responses API を操作する TypeScript 製 CLI。default / d2 / sql の 3 モードを提供し、Bun 上で動作する。
- default・d2 では会話型ワークフローと履歴管理、reasoning effort・verbosity 切り替え、画像入力、ログ要約 (`--compact`) をサポート。
- sql モードは PostgreSQL スキーマ取得・SELECT クエリの dry-run 検証・sqruff 整形を組み込み、LLM 提案とツール実行を統合する。
- エントリーポイントは `src/cli/<mode>.ts`、ビルド済み CLI は `dist/cli/<mode>.js` として `gpt-5-cli*` 各バイナリに割り当て。
- `.env` で OpenAI 認証情報や PostgreSQL DSN・sqruff パス等を管理し、テンプレートは `.env.example` にまとめる。
