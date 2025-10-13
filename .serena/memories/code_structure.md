# ディレクトリ構成メモ
- `src/cli.ts` — CLI 本体。OpenAI Responses API 呼び出しとフラグ処理を集約。
- `dist/` — `bun run build` により生成されるビルド済み CLI (`dist/cli/default.js`, `dist/cli/d2.js` など)。
- `prompts/` — モード別 system メッセージテンプレート (`<mode>.md`) を配置。
- `tests/` — 統合テスト。単体テストは各 `src/` 階層に配置。
- `history_index.json` — 実行時生成される履歴索引ファイル (環境変数で出力先変更可)。
- `docs/`, `plan_*.md` — プロジェクト計画やドキュメント。
- `.env.example` — 認証情報や既定値のテンプレート。