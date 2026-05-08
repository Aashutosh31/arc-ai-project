#!/bin/sh
set -e

# Detect an available Chromium/Chrome binary and set PUPPETEER_EXECUTABLE_PATH
CANDIDATES="${CHROMIUM_PATH:-/usr/bin/chromium} /usr/bin/chromium-browser /usr/bin/google-chrome-stable /usr/bin/google-chrome"
for p in $CANDIDATES; do
  if [ -x "$p" ]; then
    export PUPPETEER_EXECUTABLE_PATH="$p"
    break
  fi
done

# Ensure container-friendly chrome args are present
: "${PUPPETEER_ARGS:=--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage}"
export PUPPETEER_ARGS

echo "[docker-entrypoint] Using PUPPETEER_EXECUTABLE_PATH=${PUPPETEER_EXECUTABLE_PATH}"
echo "[docker-entrypoint] PUPPETEER_ARGS=${PUPPETEER_ARGS}"

exec "$@"
