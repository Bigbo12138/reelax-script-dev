#!/usr/bin/env python3
"""Test admin login with various credentials."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

# Test admin login (脱敏演示) — 请勿对他人账号执行。
tests = [
    {"email": "admin@REDACTED.example", "password": "123456"},
    {"email": "admin@REDACTED.example", "password": "admin123"},
    {"email": "admin@REDACTED.example", "password": "password"},
    {"email": "admin@REDACTED.example", "password": "12345678"},
    {"email": "admin@REDACTED.example", "password": "admin"},
    {"email": "admin@REDACTED.example", "password": "reelax123"},
]

for t in tests:
    print(f"=== POST /api/admin/auth/login {t['email']} ===")
    res = ws_bridge.request("POST", "/api/admin/auth/login", t, timeout=15)
    print(f"  status: {res.get('status')}")
    print(f"  ok: {res.get('ok')}")
    print(f"  data: {json.dumps(res.get('data'), ensure_ascii=False)[:300]}")
    print(f"  raw: {res.get('raw','')[:300]}")
    print()
    time.sleep(1)
