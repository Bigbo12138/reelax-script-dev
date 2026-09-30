#!/usr/bin/env python3
"""Test party boat IDOR and data access."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

tests = [
    ("/api/party-boats/public?limit=5", "GET", None),
    ("/api/party-boats/crowdfundings/public?limit=5", "GET", None),
    ("/api/party-boats/members/10375/remove", "GET", None),
    ("/api/party-boats/player-search?q=valetzx&limit=10", "GET", None),
    ("/api/party-boats/player-search?q=a&limit=10", "GET", None),
    ("/api/party-boats/player-search?q=ab&limit=10", "GET", None),
]

for path, method, body in tests:
    res = ws_bridge.request(method, path, body, timeout=15)
    status = res.get('status')
    data = res.get('data')
    code = data.get('error',{}).get('code') if isinstance(data,dict) else None
    print(f"\n=== {status} {path} [{code}] ===")
    if status == 200 and isinstance(data, dict):
        print(f"  keys: {list(data.keys())[:10]}")
        print(f"  data: {json.dumps(data, ensure_ascii=False)[:300]}")
    time.sleep(0.5)
