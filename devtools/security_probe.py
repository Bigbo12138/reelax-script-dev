#!/usr/bin/env python3
"""Security probing tool for reelax.cn via the bridge.

Usage:
  python3 security_probe.py --paths-file paths.txt [--method GET] [--verbose]
  python3 security_probe.py --path "/api/admin/me"
  python3 security_probe.py --scan-admin
"""
import argparse
import json
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ws_bridge

BRIDGE_PORT = 55004

def probe(path, method="GET", body=None, timeout=15):
    """Send a single request via bridge, return (status, ok, data)."""
    try:
        res = ws_bridge.request(method, path, body, timeout=timeout)
        return res.get("status"), res.get("ok"), res.get("data"), res.get("raw","")
    except Exception as e:
        return None, False, {"error": str(e)}, ""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", help="single path to probe")
    ap.add_argument("--paths-file", help="file with one path per line")
    ap.add_argument("--method", default="GET")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--scan-admin", action="store_true", help="scan common admin paths")
    ap.add_argument("--out", help="output JSON file")
    args = ap.parse_args()

    ws_bridge.start(port=BRIDGE_PORT)

    paths = []
    if args.path:
        paths = [args.path]
    elif args.paths_file:
        with open(args.paths_file) as f:
            paths = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    elif args.scan_admin:
        paths = [
            "/api/admin/", "/api/admin/me", "/api/admin/users", "/api/admin/players",
            "/api/admin/dashboard", "/api/admin/stats", "/api/admin/statistics",
            "/api/admin/config", "/api/admin/settings", "/api/admin/login",
            "/api/admin/auth", "/api/admin/auth/login", "/api/admin/auth/me",
            "/api/admin/register", "/api/admin/password", "/api/admin/reset",
            "/api/admin/players/{id}", "/api/admin/users/{id}", "/api/admin/guilds",
            "/api/admin/guilds/{id}", "/api/admin/market", "/api/admin/orders",
            "/api/admin/fish", "/api/admin/gear", "/api/admin/inventory",
            "/api/admin/items", "/api/admin/chests", "/api/admin/events",
            "/api/admin/logs", "/api/admin/audit", "/api/admin/system",
            "/api/admin/health", "/api/admin/version", "/api/admin/status",
            "/api/admin/db", "/api/admin/database", "/api/admin/backup",
            "/api/admin/export", "/api/admin/import", "/api/admin/migrations",
            "/api/admin/roles", "/api/admin/permissions", "/api/admin/roles/{id}",
            "/api/admin/bans", "/api/admin/reports", "/api/admin/tickets",
            "/api/admin/notifications", "/api/admin/broadcast", "/api/admin/announcements",
            "/api/admin/currency", "/api/admin/economy", "/api/admin/balance",
            "/api/admin/grant", "/api/admin/give", "/api/admin/redeem",
            "/api/admin/cdk", "/api/admin/codes", "/api/admin/promotions",
            "/api/admin/sponsors", "/api/admin/afdian", "/api/admin/webhooks",
            "/api/admin/integrations", "/api/admin/secrets", "/api/admin/keys",
            "/api/admin/tokens", "/api/admin/sessions", "/api/admin/ip",
            "/api/admin/security", "/api/admin/2fa", "/api/admin/otp",
            "/api/admin/totp", "/api/admin/debug", "/api/admin/test",
            "/api/admin/echo", "/api/admin/healthcheck", "/api/admin/ping",
            "/api/admin/console", "/api/admin/exec", "/api/admin/command",
            "/api/admin/shell", "/api/admin/terminal", "/api/admin/ssh",
            "/api/admin/file", "/api/admin/files", "/api/admin/upload",
            "/api/admin/download", "/api/admin/static", "/api/admin/assets",
            "/api/admin/theme", "/api/admin/customization", "/api/admin/feature",
            "/api/admin/features", "/api/admin/flag", "/api/admin/flags",
            "/api/admin/env", "/api/admin/environment", "/api/admin/config.json",
            "/api/admin/.env", "/api/admin/package.json",
        ]

    results = []
    for p in paths:
        status, ok, data, raw = probe(p, args.method)
        code = data.get("error",{}).get("code") if isinstance(data, dict) else None
        msg = data.get("error",{}).get("message") if isinstance(data, dict) else None
        entry = {"path": p, "method": args.method, "status": status, "ok": ok,
                 "code": code, "message": msg}
        if args.verbose:
            entry["data"] = data
            entry["raw"] = raw[:500]
        results.append(entry)
        if args.verbose:
            print(json.dumps(entry, ensure_ascii=False))
        else:
            line = f"{status or 'ERR':>4}  {p}"
            if code:
                line += f"  [{code}]"
            if msg:
                line += f"  {msg[:80]}"
            print(line)
        time.sleep(0.2)

    if args.out:
        with open(args.out, 'w') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\nSaved to {args.out}")

if __name__ == "__main__":
    main()
