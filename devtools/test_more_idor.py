#!/usr/bin/env python3
"""Test IDOR on market/barter/guild endpoints."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

tests = [
    ("/api/market/orders?assetType=gear&side=sell&limit=5", "GET", None),
    ("/api/party-boats/player-search?q=admin&limit=10", "GET", None),
    ("/api/party-boats/player-search?q=root&limit=10", "GET", None),
    ("/api/party-boats/player-search?q=test&limit=10", "GET", None),
    ("/api/leaderboards?category=level&limit=10", "GET", None),
    ("/api/party-boats/overview", "GET", None),
    ("/api/party-boats/crowdfundings/public?limit=20", "GET", None),
]

for path, method, body in tests:
    res = ws_bridge.request(method, path, body, timeout=15)
    status = res.get('status')
    data = res.get('data')
    code = data.get('error',{}).get('code') if isinstance(data,dict) else None
    print(f"{status} {path} [{code}]")
    if status == 200 and isinstance(data, dict):
        if 'items' in data:
            items = data['items']
            if items:
                print(f"    items: {len(items)} - first: {json.dumps(items[0], ensure_ascii=False)[:200]}")
        elif 'players' in data:
            players = data['players']
            if players:
                print(f"    players: {len(players)} - first: {json.dumps(players[0], ensure_ascii=False)[:200]}")
        else:
            print(f"    keys: {list(data.keys())[:10]}")
    time.sleep(0.5)
