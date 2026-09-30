#!/usr/bin/env python3
"""Probe more endpoints with rate-limit awareness."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

ws_bridge.start(port=55004)

paths = []
with open('/tmp/probe_more.txt') as f:
    paths = [l.strip() for l in f if l.strip() and not l.startswith('#')]

results = []
for p in paths:
    res = ws_bridge.request("GET", p, None, timeout=15)
    status = res.get('status')
    data = res.get('data')
    code = data.get('error',{}).get('code') if isinstance(data, dict) else None
    msg = data.get('error',{}).get('message') if isinstance(data, dict) else None
    entry = {"path": p, "status": status, "ok": res.get('ok'), "code": code, "message": msg}
    results.append(entry)
    
    line = f"{status or 'ERR':>4}  {p}"
    if code:
        line += f"  [{code}]"
    if msg and status not in (200, 404):
        line += f"  {msg[:60]}"
    print(line)
    
    # Rate limit handling: pause if 429
    if status == 429:
        time.sleep(2)
    else:
        time.sleep(0.3)

with open('/tmp/probe_more_results.json', 'w') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print(f"\nSaved to /tmp/probe_more_results.json")
