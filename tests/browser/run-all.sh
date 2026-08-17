#!/usr/bin/env bash
# Every browser suite, in order. Needs a server on APP_URL and a built cheat sheet.
#
#   npm --prefix client run build          # the app the server serves
#   node server/scripts/build-cheatsheet.js # the standalone sheet
#   node server/index.js &                  # or point APP_URL elsewhere
#   bash tests/browser/run-all.sh
#
# Playwright is not a project dependency — install it where you run these:
#   npm install --no-save playwright
# and set PLAYWRIGHT_CHROMIUM if a prebuilt browser is available.
set -u
cd "$(dirname "$0")"
fails=0
for t in workflows toggletest verify1 allviews csnew cstoggle final draftsync; do
  printf '%-14s ' "$t"
  if node "$t.js" > "/tmp/browser-$t.log" 2>&1; then
    echo PASS
  else
    echo "FAIL  (see /tmp/browser-$t.log)"
    fails=$((fails + 1))
  fi
done
echo
[ "$fails" -eq 0 ] && echo "all browser suites passed" || echo "$fails suite(s) failed"
exit "$fails"
