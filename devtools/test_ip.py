#!/usr/bin/env python3
"""Test player IP/data exposure."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

tests = [
    ("/api/players/10375/statistics", "GET", None),
    ("/api/players/10375", "GET", None),
    ("/api/market/me/state", "GET", None),
    ("/api/sponsorship/me", "GET", None),
    ("/api/sponsorship/credits?limit=5", "GET", None),
    ("/api/history", "GET", None),
    ("/api/account", "GET", None),
]

for path, method, body in tests:
    res = ws_bridge.request(method, path, body, timeout=15)
    status = res.get('status')
    data = res.get('data')
    code = data.get('error',{}).get('code') if isinstance(data,dict) else None
    print(f"\n=== {status} {path} [{code}] ===")
    if status == 200 and isinstance(data, dict):
        s = json.dumps(data, ensure_ascii=False)
        if 'email' in s.lower():
            print(f"  !! CONTAINS EMAIL: {s[:500]}")
        if '"ip"' in s.lower() or 'ipAddress' in s:
            print(f"  !! CONTAINS IP: {s[:500]}")
        if 'password' in s.lower() or 'secret' in s.lower():
            print(f"  !! CONTAINS SECRET: {s[:500]}")
        else:
            print(f"  keys: {list(data.keys())[:10]}")
            print(f"  data: {s[:200]}")
    time.sleep(0.5)
