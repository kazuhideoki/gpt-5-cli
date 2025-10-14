# レイヤー境界と Biome 設定

- 依存方向は `core <- session <- cli` のみ許可（逆方向は禁止）。
- Lint は Biome を使用し、以下を `biome.json` の `overrides` で強制する。
  - `src/core/**/*`: `noRestrictedImports` に `@session/*`・`@cli/*`・`../**/session/**`・`../**/cli/**` を禁止。
  - `src/session/**/*`: `noRestrictedImports` に `@cli/*`・`../**/cli/**` を禁止。
- 例外設定は作らない（型だけ許可などもしない）。
- チェックコマンド: `bun run lint`（設定の存在が最優先。修正は後続タスク）。

メモ:
- 循環依存は `rules.nursery.noImportCycles = error` を利用。
- パスエイリアス（`@core/*`, `@session/*`, `@cli/*`）の導入は任意だが、層越境の検出精度が上がる。
