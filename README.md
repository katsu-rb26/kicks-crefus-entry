# kicks-crefus-entry

Kicks/crefus 体験会受付管理システムの画面（`app/` 配下）。GitHub Pagesでホスティングしている。

## CSS/JSのバージョン更新

`app/index.html` の `<link rel="stylesheet">` と自前の `<script src="js/...">` には、iPhoneのホーム画面アプリ等でキャッシュが残り修正が届かない事故を防ぐため、`?v=日付+連番`（例: `20261014a`）を付けている。CSS/JSを変更したときは、コミット前に以下を実行してバージョンを更新する。

```sh
scripts/bump-version.sh
```

引数なしで実行すると、`app/index.html` 内のバージョンを今日の日付＋連番（同日中は a→b→c…、日付が変われば新しい日付+aから）に書き換える。vendor配下（バージョン固定のライブラリ）には付けない。

## アイコンの更新

アイコン画像（`app/assets/icons/`）を差し替えるときは、`app/index.html` のアイコン系 `<link>` の `href` と、`app/manifest.json` の `icons[].src` の両方に、CSS/JSとは別の日付+連番（例: `?v=20261015a`）を手動で付け直す（`scripts/bump-version.sh` はアイコンを更新しない）。
