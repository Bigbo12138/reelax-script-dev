#!/usr/bin/env python3
"""Test market security."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

tests = [
    ("/api/market/config", "GET", None),
    ("/api/market/fish/overview", "GET", None),
    ("/api/market/orders?assetType=gear&side=sell&limit=1&rarities=arcane", "GET", None),
    ("/api/market/orders?assetType=fish&side=buy&limit=1", "GET", None),
    ("/api/market/me/state", "GET", None),
    ("/api/barter/orders?limit=1", "GET", None),
]

for path, method, body in tests:
    res = ws_bridge.request(method, path, body, timeout=15)
    status = res.get('status')
    data = res.get('data')
    code = data.get('error',{}).get('code') if isinstance(data,dict) else None
    print(f"\n=== {status} {path} [{code}] ===")
    if status == 200 and isinstance(data, dict):
        s = json.dumps(data, ensure_ascii=False)
        print(f"  keys: {list(data.keys())[:8]}")
        print(f"  preview: {s[:200]}")
    time.sleep(0.5)
