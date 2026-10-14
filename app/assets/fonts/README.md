# 書体（Zen Maru Gothic）

- 書体: Zen Maru Gothic（500 / 700）
- ライセンス: SIL Open Font License 1.1（全文は `OFL-ZenMaruGothic.txt`）。Reserved Font Name の指定なし
- ファイルは**サブセット**（「体験会管理ボード」「Kicks×crefus」、数字0〜9、ハイフン、半角スペースのみ）。これ以外の文字は含まれず、フォールバック書体で表示される
- 用途: ヘッダーのタイトル・年度、ログイン画面のタイトルのみ（`css/style.css` の `--font-brand`）
- 取得元: https://github.com/google/fonts/tree/main/ofl/zenmarugothic （ZenMaruGothic-Medium.ttf / ZenMaruGothic-Bold.ttf）

## 更新手順
1. 公式のttfを取得し、`pyftsubset <ttf> --text="<使う文字>" --flavor=woff2 --layout-features='*' --output-file=zen-maru-gothic-<太さ>.v<N>.woff2` で作り直す（fonttools と brotli が必要）
2. ファイル名のバージョン（`.v1` → `.v2`）を上げ、`css/style.css` の `@font-face` の url を更新する
3. 表示する文字を増やす場合は、`--text` に追加して作り直す
4. `scripts/bump-version.sh` を実行して `?v=` を更新する
