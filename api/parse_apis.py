#!/usr/bin/env python3
"""
parse_apis.py —— 从 reelax 线上前端 bundle 逆向提取 /api/* 端点。

能做什么：
  1. 抓首页拿当前 bundle hash（随发版变），下载 bundle；或 --bundle 直接解析本地文件
  2. 提取所有 /api/* 字面路径（去重）
  3. 从 bundle 里**运行时提取免签白名单数组**（权威来源）+ /api/me，标注每个端点是否需签
  4. 尽量反出 HTTP 方法：扫路径前后 ±200 字符里的 method:"POST|PUT|DELETE|PATCH|GET"
  5. 按二级路径分组输出（文本 / --json / --save 落盘）
  6. --diff api/api.md：比对本文件，列出「bundle 有但文档没有」（新增）和
     「文档有但 bundle 没有」（可能已废弃/重命名）

仅用标准库。网络不可用或不需重抓时，用 --bundle /tmp/reelax.js 离线跑。

用法：
  python3 api/parse_apis.py
  python3 api/parse_apis.py --bundle /tmp/reelax.js
  python3 api/parse_apis.py --json
  python3 api/parse_apis.py --diff api/api.md
  python3 api/parse_apis.py --save api/endpoints.gen.md
"""
import argparse
import json
import re
import sys
import urllib.request

HOME_URL = "https://reelax.cn/"
API_RE = re.compile(r'/api/[A-Za-z0-9_/{}:$.()-]+')
# 路径前后窗口内找 method:"X"
METHOD_RE = re.compile(r'method\s*:\s*"(GET|POST|PUT|DELETE|PATCH)"')
WHITELIST_RE = re.compile(r'\[("/api/[^]]*?")\]')
ME_PATH = "/api/me"


def fetch_text(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "reelax-api-parser/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def resolve_bundle_url(home=HOME_URL):
    html = fetch_text(home)
    m = re.search(r'(https://static\.reelax\.cn/assets/index-[A-Za-z0-9_.\-]+\.js)', html)
    if not m:
        raise RuntimeError("首页没找到 bundle 引用，可能改版了")
    return m.group(1)


def normalize(path):
    # 模板字符串 /api/baits/${encodeURIComponent(baitId)}/equip
    # -> /api/baits/{id}/equip，和 api.md 的 {id} 风格统一
    path = re.sub(r'\$\{[^}]*\}', '{id}', path)
    # 丢弃末尾没闭合的 ${... 残片（如 /api/guilds/me/${a）
    path = re.sub(r'\$\{[^}]*$', '', path)
    path = path.rstrip("/").rstrip("'\"")
    return path


def extract_paths(js):
    seen = set()
    for m in API_RE.finditer(js):
        p = normalize(m.group(0))
        if p and p != "/api":
            seen.add(p)
    return sorted(seen)


def extract_whitelist(js):
    """从 bundle 里抓免签白名单数组（权威来源）。"""
    s = set()
    m = WHITELIST_RE.search(js)
    if m:
        try:
            arr = json.loads(m.group(0))
            for x in arr:
                if isinstance(x, str) and x.startswith("/api/"):
                    s.add(x)
        except Exception:
            pass
    s.add(ME_PATH)  # /api/me 由签名客户端特判免签（见 sign.js PROOF_ME_PATH）
    return s


def guess_methods(js, path):
    """路径可能在多处出现，收集出现过的 verb；有非 GET 就报它，否则 GET。"""
    verbs = set()
    for m in re.finditer(re.escape(path), js):
        lo = max(0, m.start() - 300)
        hi = min(len(js), m.end() + 400)
        win = js[lo:hi]
        for vm in METHOD_RE.finditer(win):
            verbs.add(vm.group(1))
    if not verbs:
        return "GET", False  # GET 为默认猜测
    if "GET" in verbs and len(verbs) == 1:
        return "GET", False
    # 优先报写操作
    for v in ("POST", "PUT", "DELETE", "PATCH", "GET"):
        if v in verbs:
            return v, True
    return "GET", False


def group_of(path):
    parts = path.strip("/").split("/")
    return parts[1] if len(parts) > 1 else parts[0]


def build_report(js):
    paths = extract_paths(js)
    whitelist = extract_whitelist(js)
    rows = []
    for p in paths:
        method, certain = guess_methods(js, p)
        sign = "免签" if p in whitelist else "需签"
        rows.append({
            "path": p,
            "method": method,
            "method_certain": certain,
            "sign": sign,
            "group": group_of(p),
        })
    return rows, sorted(whitelist)


def print_text(rows, whitelist):
    groups = {}
    for r in rows:
        groups.setdefault(r["group"], []).append(r)
    print(f"共提取 {len(rows)} 个端点；免签白名单 {len(whitelist)} 个：{', '.join(whitelist)}")
    print("=" * 72)
    for g in sorted(groups):
        print(f"\n## {g}  ({len(groups[g])})")
        for r in sorted(groups[g], key=lambda x: x["path"]):
            m = r["method"] + ("" if r["method_certain"] else "?")
            print(f"  [{r['sign']:>3}] {m:<6} {r['path']}")


def read_md_paths(md_path):
    with open(md_path, encoding="utf-8") as f:
        txt = f.read()
    return set(API_RE.findall(txt))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", help="直接解析本地 bundle 文件（跳过下载）")
    ap.add_argument("--home", default=HOME_URL, help="首页 URL（用于解析 bundle 名）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--diff", metavar="MD", help="与 api.md 对比，列出新增/可能废弃")
    ap.add_argument("--save", metavar="FILE", help="把文本报告写到文件")
    args = ap.parse_args()

    if args.bundle:
        with open(args.bundle, encoding="utf-8", errors="replace") as f:
            js = f.read()
        src = args.bundle
    else:
        bundle_url = resolve_bundle_url(args.home)
        print(f"bundle: {bundle_url}", file=sys.stderr)
        js = fetch_text(bundle_url)
        src = bundle_url

    rows, whitelist = build_report(js)

    if args.json:
        print(json.dumps({"source": src, "whitelist": whitelist, "endpoints": rows},
                         ensure_ascii=False, indent=2))
        return

    print_text(rows, whitelist)

    if args.diff:
        md_paths = read_md_paths(args.diff)
        bundle_paths = {r["path"] for r in rows}
        new = sorted(bundle_paths - md_paths)
        stale = sorted(md_paths - bundle_paths)
        print("\n" + "=" * 72)
        print(f"与 {args.diff} 对比：")
        print(f"  新增（bundle 有、文档无）：{len(new)}")
        for p in new:
            print(f"    + {p}")
        print(f"  可能废弃（文档有、bundle 无）：{len(stale)}")
        for p in stale:
            print(f"    - {p}")

    if args.save:
        import io
        buf = io.StringIO()
        old_stdout = sys.stdout
        sys.stdout = buf
        print_text(rows, whitelist)
        sys.stdout = old_stdout
        with open(args.save, "w", encoding="utf-8") as f:
            f.write(buf.getvalue())
        print(f"\n已写入 {args.save}", file=sys.stderr)


if __name__ == "__main__":
    main()
