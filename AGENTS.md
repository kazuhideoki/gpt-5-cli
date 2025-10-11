# Repository Guidelines

## プロジェクト構成とモジュール
- 主要ロジックは `src/cli.ts` に集約され、OpenAI Responses API をラップしています。
- ビルド済みエントリーポイントは `dist/cli.js` で、`bun run build` により `src` から生成されます。
- `.env` は `OPENAI_API_KEY` などの認証情報を保持し、共有用の既定値は `.env.example` を更新してください。
- `history_index.json` は実行時に生成される会話履歴の索引用ファイルで、`OPENAI_HISTORY_INDEX_FILE` で出力先を変更できます。
- `system_prompt.txt` は新規会話開始時の system メッセージテンプレートとして利用できます。

## ビルド・テスト・開発コマンド
- `bun install`: 依存パッケージをインストール。
- `bun run build`: TypeScript をコンパイルして `dist/` 以下を更新。
- `bun run dev`: `tsx` 実行で `src/cli.ts` をホットリロード付きで起動。
- `bun run start -- --help`: ビルド済み CLI のヘルプを確認。
- `OPENAI_HISTORY_INDEX_FILE=/tmp/history.json NO_COLOR=1 bun run start -- -r`: 履歴機能の安定出力を検証するサンプル。

## コーディングスタイルと命名規約
- TypeScript は `strict` 設定、ES Modules (`type: module`) を採用。
- インデントは 2 スペース、暗黙の `any` は禁止。
- ログは `console.error` に送出し、ユーザー向けメッセージは `console.log` または `process.stdout.write` を利用。
- 関数・主要モジュールには JSDoc コメントを付与して意図を明示します。型はコメントでは無く Typescript 型定義すること
- ファイル・識別子名は役割が伝わる英語名を使用し、CLI フラグは短縮形とロングオプションをペアで定義する方針です。
- バリデーションやスキーマ検証が必要な場合は可能な限り `zod` を利用し、ランタイム整合性とエラーメッセージの統一を図ります。

## テストガイドライン
- まず `bun run build` で型エラーがないか確認すること
- 次に `bun run lint` と `bun run format:check` を必ず実行し、エラーや差分が無いことを確認してください。
- そして `bun run test` を実行し、テストが全て成功することを確認してください。
- 履歴関連変更時は前述の `-r` 例コマンドで出力差分を確認し、`jq . history_index.json` で JSON 整合性をチェックします。
- 機能追加や更新では、必ず回帰を防ぐために `src/` 配下へ軽量な単体テストや `tests/` 配下へ統合テストの追加を検討してください。

## コミットとPRガイドライン
- コミットメッセージは Conventional Commits (`feat(cli): ...` / `fix(history): ...`) に従います。
- PR には背景、実装概要、影響範囲、手動確認手順、関連 Issue を記載し、フラグ変更時は `README.md` と CLI ヘルプを同期させます。
- Pull Request 説明には `bun run build` 結果や対話ログの抜粋など検証証跡を添付してください。

## セキュリティと設定の注意
- `.env` をコミットせず、共有情報は `.env.example` に反映します。
- 履歴ファイルには機微情報が含まれる可能性があるため、共有前に `OPENAI_HISTORY_INDEX_FILE` で書き出し先を変更するか、不要データを削除してください。

## 個人用スクリプトとしての運用
- 開発効率を優先し、フォールバック処理は不要です。入力検証で異常を検知した場合は即座にエラーを投げ、早期に失敗を把握してください。
- メソッドやコードパスは指示がない限り最小限の完成度で構いません。追加要件が生じたタイミングで拡張してください。基本的に後方互換性も不要です。

## アーキテクチャ概要
- OpenAI Node SDK の `responses.create` を使用し、会話継続には `previous_response_id` を付加します。
- 履歴は `history_index.json` に追記保存され、CLI からのオプション指定で読み書きパスを切り替えられます。
