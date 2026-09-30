#!/bin/bash
# 批量下载 chunk 的 source map
set -e
cd /workspace/firefoxfish
TAB="$1"
shift
for chunk in "$@"; do
  base=$(basename "$chunk" .js)
  out="/workspace/pigfish/maps/admin-chunks/${base}.js.map"
  if [ -f "$out" ] && [ -s "$out" ]; then
    echo "skip $base (exists)"
    continue
  fi
  echo "fetch $base ..."
  python3 devtools/fetch_map.py "https://admin.reelax.cn/$chunk.map" "$out" --chunk 30000 --tab "$TAB" > /tmp/chunk_fetch.log 2>&1 || {
    echo "FAILED $base"; cat /tmp/chunk_fetch.log | tail -3
  }
done
echo "ALL DONE"
