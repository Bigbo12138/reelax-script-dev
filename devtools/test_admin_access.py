#!/usr/bin/env python3
"""Test admin endpoint access from player context without signature."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

tests = [
    "/api/admin/",
    "/api/admin/auth/session",
    "/api/admin/dashboard",
    "/api/admin/players",
    "/api/admin/audit",
    "/api/admin/analytics/rarity-drops",
    "/api/admin/market/abnormal-trades",
    "/api/admin/sponsorship/overview",
    "/api/admin/world-boss",
    "/api/admin/daily-check-in/rewards",
    "/api/admin/arcane-sacrifice/targets",
]

for path in tests:
    res = ws_bridge.request("GET", path, None, timeout=15)
    status = res.get('status')
    data = res.get('data')
    code = data.get('error',{}).get('code') if isinstance(data,dict) else None
    msg = data.get('error',{}).get('message') if isinstance(data,dict) else None
    print(f"{status} {path} [{code}] {msg if msg else ''}")
    if status == 200:
        print(f"    -> {json.dumps(data, ensure_ascii=False)[:300]}")
    time.sleep(0.5)
