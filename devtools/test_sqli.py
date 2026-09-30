#!/usr/bin/env python3
"""Test for SQL injection / injection on query params."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

tests = [
    # SQL injection attempts
    ("/api/guilds/search?q=' OR '1'='1", "GET"),
    ("/api/guilds/search?q=' OR 1=1--", "GET"),
    ("/api/guilds/search?q=' UNION SELECT 1--", "GET"),
    ("/api/guilds/search?q=%27%20OR%20%271%27%3D%271", "GET"),
    ("/api/party-boats/player-search?q=' OR '1'='1&limit=10", "GET"),
    ("/api/party-boats/player-search?q=test' OR '1'='1&limit=10", "GET"),
    # Command injection
    ("/api/guilds/search?q=test;ls", "GET"),
    ("/api/guilds/search?q=$(cat /etc/passwd)", "GET"),
    # Path traversal in query params
    ("/api/guilds/search?q=../../etc/passwd", "GET"),
    # NoSQL injection
    ("/api/guilds/search?q[$ne]=x", "GET"),
    # Mass assignment
    ("/api/account/password", "POST"),
]

for path, method in tests:
    res = ws_bridge.request(method, path, None if method == "GET" else {"newPassword":"test12345678"}, timeout=15)
    status = res.get('status')
    data = res.get('data')
    code = data.get('error',{}).get('code') if isinstance(data,dict) else None
    msg = data.get('error',{}).get('message') if isinstance(data,dict) else None
    print(f"{status} {method} {path} [{code}] {msg if msg else ''}")
    if status == 200 and isinstance(data, dict):
        print(f"    -> data keys: {list(data.keys())[:5]}")
    time.sleep(0.5)
