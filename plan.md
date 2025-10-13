# 目的

この計画は作業ブランチ `work` で進める SQL モード開発の方針を示す。SELECT 文のみに対象を限定した SQL 生成/修正タスク機能を CLI に追加し、PostgreSQL 接続を通じたスキーマ取得・ドライラン検証・sqruff 整形をまとめて扱えるようにする。初期段階では方言を PostgreSQL に限定し、将来的な MySQL/SQLite 拡張を阻害しない構成を意識する。

## ブランチ運用方針

- `work` ブランチでは SQL モードに関連する設計と実装を完結させ、`main` からの差分を継続的に取り込む。
- SQL モードに不要な変更は極力別ブランチへ分離し、`work` のスコープを SQL ワークフロー整備に限定する。
- 作業完了時は `main` へマージする前に `bun run build` などのベーシックチェックを通過させ、CLI 分岐やドキュメントを最新化する。

# 成果物

- ツール
  - `sql schema`（仮称）: PostgreSQL接続情報を受け取り、`information_schema`からテーブル/カラム情報を取得して標準出力へ返すサブコマンド。
  - `sql dry-run`: 与えられた SQL（SELECT 限定）を `EXPLAIN`/`PREPARE` で実行せず検証し、結果やエラーメッセージを整形して返すサブコマンド。
  - `sql format`: sqruff を呼び出し、SELECT クエリを整形するサブコマンド。失敗時はエラーメッセージを CLI に反映。
- 元 SQL（SELECT 限定）・意図（オプション）・スキーマ情報を入力として LLM に修正案を求め、`sql dry-run` と `sqruff` を通した結果を返すワークフロー。(d2 などでやっているタスクのループ)
- `.env`経由でPostgreSQL DSNやsqruffパスなどの設定を読み込む初期実装。
- history_index.json の SQL タスクエントリは既存の共通フィールドに加え、下記の `task.sql` 構造を採用する。
  ```json
  [
    {
      "...": "...",
      "task": {
        "mode": "sql",
        "sql": {
          "type": "postgresql",
          "dsn_hash": "sha256:...",
          "connection": {
            "host": "db.internal",
            "port": 5432,
            "database": "analytics",
            "user": "reporter"
          }
        }
      }
    }
  ]
  ```

# 実現方法

1. CLI構造整理
   - 既存の`src/cli.ts`にSQL関連サブコマンドを追加できるよう、最小限のコマンド登録ヘルパーを導入する。
   - 方言情報を `Dialect` 型で表現し、当面は `postgres` のみ許容するバリデーションを入れる。
   - コマンド実行時に入力 SQL が SELECT 文であることを静的にチェックし、非対応ステートメントは明示的に拒否する。
2. 設定ローダー
   - `.env`を読み込み、`POSTGRES_DSN`などの必須情報をチェックするユーティリティを実装。欠落時にはCLIで明確に警告。
3. スキーマ取得
   - `pg`（または`postgres`パッケージ）を用いてDSNから接続し、`information_schema.columns`をクエリしてJSON出力。キャッシュは導入しない。
4. ドライラン
   - `BEGIN; PREPARE; DEALLOCATE; ROLLBACK;`テンプレートを利用し、副作用なしで構文/型検証を実施。`EXPLAIN (VERBOSE, COSTS OFF)`も呼び、標準出力に整形表示。
5. フォーマット
   - sqruffをサブプロセスとして実行し、整形済みSQLを受け取る。sqruffが未インストールの場合はエラーガイドを表示。
6. LLM修正ループ
   - 入力SQL、意図文字列（`--intent`）、スキーマ結果、ドライランエラーをまとめてOpenAI Responses APIに渡し、提案SQLを受け取る。
   - 提案SQLに対し`sqruff`と`dry-run`を再実行し、成功した場合のみ結果を採用。失敗時はフィードバックを載せて再試行（回数制限付き）。
7. 出力設計
   - 初期はテキスト出力のみ
   - dry-run結果やsqruffエラーは標準エラーに出力し、成功時は整形済みSQLを標準出力に書き出す。
8. テスト
   - `bun run build/lint/format/test`のCIパスを維持しつつ、`tests/`にPostgreSQLモックを用いた統合テストを準備（最小限のhappy pathとエラーケース）。
