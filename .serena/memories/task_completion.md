# タスク完了時のチェックリスト
1. `bun run build` で TypeScript コンパイルと型エラー確認。
2. `bun run lint` を実行して Biome の静的解析が通るか確認。
3. `bun run format:check` でフォーマットルール違反がないか確認。
4. `bun run test` でテストが成功するか確認。
5. 履歴関連を変更した場合は `GPT_5_CLI_HISTORY_INDEX_FILE=/tmp/history.json NO_COLOR=1 bun run start -- -r` や `jq . history_index.json` で出力・JSON 整合性を点検する。
6. 必要に応じて `prompts/<mode>.md` の更新と CLI ヘルプ (`bun run start -- --help` など) を同期する。