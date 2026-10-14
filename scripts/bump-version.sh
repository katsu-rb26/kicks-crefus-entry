#!/bin/bash
# app/index.html内の、css/style.css と js/*.js の読み込みタグに付けた ?v=バージョン番号だけを
# 更新する（iPhoneホーム画面アプリ等のキャッシュ対策）。
# アイコン(apple-touch-icon/favicon)やmanifest.jsonの?v=は、別の仕組み（手動）で管理しており、
# このスクリプトは対象外として一切触らない（vendor配下のChart.jsも元から対象外）。
# 引数なしで実行するだけでよい。同じ日に複数回実行すると連番(a→b→c…)が進み、
# 日付が変わっていれば新しい日付+aに戻る。macOSのsed(BSD sed, sed -i '' -E)で動作する。
set -euo pipefail

cd "$(dirname "$0")/.."
TARGET="app/index.html"

# css/style.css・js/*.js以外の?v=（アイコン等）を、実行前後で一切変わっていないことを確認する基準として保存する
OTHER_BEFORE=$(grep -E '\?v=' "$TARGET" | grep -vE 'css/style\.css\?v=|js/[a-zA-Z_-]+\.js\?v=' || true)

TODAY=$(date +%Y%m%d)
CURRENT=$(grep -oE 'css/style\.css\?v=[0-9]{8}[a-z]' "$TARGET" | head -1 | sed -E 's/.*\?v=//')

if [ -z "$CURRENT" ]; then
  echo "css/style.css の ?v=日付+連番 が見つかりませんでした。初回設定はこのスクリプトでは行いません。" >&2
  echo "app/index.html の css/style.css・js/*.js の<link>/<script>に、手動で ?v=${TODAY}a を付けてください。" >&2
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

# css/style.css?v=... と js/<ファイル名>.js?v=... の直後のバージョンだけを置換する
# （アイコン・manifest.jsonの?v=は別のパス文字列のため、このパターンにはそもそも一致しない）
sed -i '' -E "s#(css/style\.css\?v=|js/[a-zA-Z_-]+\.js\?v=)${CURRENT}#\1${NEW}#g" "$TARGET"

OTHER_AFTER=$(grep -E '\?v=' "$TARGET" | grep -vE 'css/style\.css\?v=|js/[a-zA-Z_-]+\.js\?v=' || true)

if [ "$OTHER_BEFORE" != "$OTHER_AFTER" ]; then
  echo "エラー: 対象外（アイコン等）の?v=が変化しました。意図しない置換が起きている可能性があるため、確認してください。" >&2
  echo "--- 実行前 ---" >&2
  echo "$OTHER_BEFORE" >&2
  echo "--- 実行後 ---" >&2
  echo "$OTHER_AFTER" >&2
  exit 1
fi

CHANGED_COUNT=$(grep -cE "(css/style\.css|js/[a-zA-Z_-]+\.js)\?v=${NEW}" "$TARGET" || true)

echo "バージョンを更新しました: ${CURRENT} -> ${NEW}"
echo "対象ファイル: ${TARGET}（css/style.css・js/*.js の ${CHANGED_COUNT} 箇所）"
echo "対象外（アイコン等）の?v=は変化していないことを確認しました。"
