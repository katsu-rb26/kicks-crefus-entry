#!/bin/bash
# app/index.html内の ?v=バージョン番号 を更新する（iPhoneホーム画面アプリ等のキャッシュ対策）。
# 引数なしで実行するだけでよい。同じ日に複数回実行すると連番(a→b→c…)が進み、
# 日付が変わっていれば新しい日付+aに戻る。macOSのsed(BSD sed, sed -i '')で動作する。
set -euo pipefail

cd "$(dirname "$0")/.."
TARGET="app/index.html"

TODAY=$(date +%Y%m%d)
CURRENT=$(grep -o '?v=[0-9]\{8\}[a-z]' "$TARGET" | head -1 | sed 's/?v=//')

if [ -z "$CURRENT" ]; then
  echo "?v=日付+連番 の形式のバージョンが見つかりませんでした。初回設定はこのスクリプトでは行いません。" >&2
  echo "app/index.html の <link>/<script> に手動で ?v=${TODAY}a を付けてください。" >&2
  exit 1
fi

CUR_DATE="${CURRENT:0:8}"
CUR_SEQ="${CURRENT: -1}"
if [ "$CUR_DATE" = "$TODAY" ]; then
  CUR_SEQ_CODE=$(printf '%d' "'$CUR_SEQ")
  NEW_SEQ=$(printf "\\$(printf '%03o' "$((CUR_SEQ_CODE + 1))")")
  NEW="${TODAY}${NEW_SEQ}"
else
  NEW="${TODAY}a"
fi

sed -i '' "s/?v=${CURRENT}/?v=${NEW}/g" "$TARGET"

echo "バージョンを更新しました: ${CURRENT} -> ${NEW}"
echo "対象ファイル: ${TARGET}"
