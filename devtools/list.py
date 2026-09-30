#!/usr/bin/env python3
# list.py —— 通过 RDP 搜查 / 盘点正在运行的页面
#
# 与 rdp_query.py 的关系：
#   RDP 的拆包、getTarget、evaluateJSAsync 等脆弱逻辑都在 rdp_query.py 里调通了，
#   本脚本直接复用它的 RDP 客户端与辅助函数，只专注于"搜查页面"这件事。
#
# 用法：
#   python3 list.py                  # 默认列出标签页(自动检测调试端口)
#   python3 list.py --port 36353 tabs # 手动指定端口（缺省时自动检测）
#   python3 list.py search 金币       # 搜查 DOM 叶子节点里含"金币"的文本
#   python3 list.py sel ".gold-value" # 列出匹配某 CSS 选择器的元素
#   python3 list.py class topbar     # 按 class 子串搜查元素
#   python3 list.py text ".gold-value"  # 读取某元素的文本
#   python3 list.py gold             # 金币余额
#   python3 list.py relic            # 遗物
#   python3 list.py fragment         # 奥秘碎片
#
# 端口缺省时自动检测（复用 rdp_query.resolve_port）：
#   从运行中的 firefox 进程 / 启动日志找 web-ext 的 -start-debugger-server 端口。
#
# 依赖：仅标准库 + 同目录 rdp_query.py（提供 RDP 客户端与端口检测）

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rdp_query import RDP, get_console_actor, resolve_port  # 复用已调通的 RDP 客户端

DEFAULT_HOST = "127.0.0.1"


def grip_to_python(grip):
    """把 RDP 返回的 grip 还原成 Python 原生值（字符串/数字/布尔），否则返回 dict。"""
    if grip is None:
        return None
    if not isinstance(grip, dict):
        return grip
    gtype = grip.get("type")
    if gtype in ("string", "number", "boolean"):
        return grip.get("value")
    if gtype == "undefined":
        return None
    return grip  # 对象/数组等，交给调用方处理


def eval_value(rdp, expr, tab_index=0):
    """在指定标签页执行 JS，返回 Python 原生值（或原始 grip dict）。"""
    rdp.greeting()  # 消费服务端主动发来的 greeting，避免被当成 listTabs 的响应
    tabs = rdp.request("root", "listTabs").get("tabs", [])
    if not tabs or tab_index >= len(tabs):
        raise RuntimeError("没有可用的标签页 / tab 索引越界")
    actor = get_console_actor(rdp, tabs[tab_index])
    if not actor:
        raise RuntimeError("拿不到 consoleActor，无法执行 JS")
    ack = rdp.request(actor, "evaluateJSAsync", {"text": expr})
    rid = ack.get("resultID")
    if rid is None:
        raise RuntimeError("evaluateJSAsync 未返回 resultID: " + json.dumps(ack, ensure_ascii=False))
    pkt = rdp.read_until(
        lambda p: p.get("type") == "evaluationResult" and p.get("resultID") == rid
    )
    if pkt.get("exceptionMessage"):
        raise RuntimeError("页面 JS 执行抛错: " + pkt["exceptionMessage"])
    return grip_to_python(pkt.get("result"))


def cmd_tabs(rdp):
    g = rdp.greeting()
    tabs = rdp.request("root", "listTabs").get("tabs", [])
    print(f"✅ 已连接 Firefox (applicationType={g.get('applicationType')})")
    print(f"📋 共 {len(tabs)} 个标签页:\n")
    for i, t in enumerate(tabs):
        print(f"  [{i}] {t.get('title', '(无标题)')}")
        print(f"      actor: {t.get('actor')}")
        print(f"      url  : {t.get('url', '')}")


def _elements_expr(js_filter):
    """构造一段返回 JSON 字符串的 JS：把匹配元素(类+文本)列出来。"""
    return (
        "(function(){"
        "return JSON.stringify("
        "[...document.querySelectorAll('*')]"
        f".filter({js_filter})"
        ".map(e=>({cls:e.className.toString().slice(0,50),"
        "txt:e.textContent.trim().slice(0,80)}))"
        ".slice(0,60));"
        "})()"
    )


def _print_elements(rdp, expr):
    raw = eval_value(rdp, expr)
    if raw is None:
        print("(无匹配)")
        return
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except Exception:
            print(raw)
            return
    elif isinstance(raw, dict):
        data = raw.get("ownProperties", raw)
    else:
        data = raw
    if not data:
        print("(无匹配)")
        return
    print(f"🔎 命中 {len(data)} 个:\n")
    for item in data:
        print(f"  .{item.get('cls','')}")
        print(f"     {item.get('txt','')}")


def cmd_search(rdp, keyword):
    kw = json.dumps(keyword)
    flt = f"(e=>(e.textContent||'').includes({kw})&&e.children.length===0)"
    print(f"🔎 搜查 DOM 中含 {kw} 的叶子文本：")
    _print_elements(rdp, _elements_expr(flt))


def cmd_class(rdp, substr):
    sub = json.dumps(substr)
    flt = f"(e=>e.className.toString().includes({sub}))"
    print(f"🔎 按 class 子串 {sub} 搜查元素：")
    _print_elements(rdp, _elements_expr(flt))


def cmd_sel(rdp, css):
    sel = json.dumps(css)
    expr = (
        "(function(){"
        f"return JSON.stringify([...document.querySelectorAll({sel})]"
        ".map(e=>({cls:e.className.toString().slice(0,50),"
        "txt:e.textContent.trim().slice(0,80)})));"
        "})()"
    )
    print(f"🔎 CSS 选择器 {sel} 命中：")
    _print_elements(rdp, expr)


def cmd_text(rdp, css):
    sel = json.dumps(css)
    expr = (
        f"(document.querySelector({sel})?document.querySelector({sel})"
        ".textContent.trim():'未找到')"
    )
    val = eval_value(rdp, expr)
    print(f"📄 {sel} => {val}")


RESOURCE_MAP = {
    "gold": ".gold-value",
    "relic": ".relic-value",
    "fragment": ".fragment-value",
}
RESOURCE_LABEL = {"gold": "金币", "relic": "遗物", "fragment": "奥秘碎片"}


def cmd_resource(rdp, name):
    sel = RESOURCE_MAP[name]
    seljs = json.dumps(sel)
    expr = (
        f"(document.querySelector({seljs})?document.querySelector({seljs})"
        ".textContent.trim():'未找到')"
    )
    val = eval_value(rdp, expr)
    print(f"💰 {RESOURCE_LABEL[name]}: {val}")


def main():
    p = argparse.ArgumentParser(description="通过 RDP 搜查/盘点 Firefox 页面")
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--port", type=int, default=None,
                   help="调试端口；缺省时自动检测 web-ext 的 -start-debugger-server 端口")
    p.add_argument("cmd", nargs="?", default="tabs",
                   help="tabs | search <词> | sel <CSS> | class <子串> | text <CSS> | gold | relic | fragment")
    p.add_argument("arg", nargs="?", default=None, help="search/sel/class/text 的关键词或选择器")
    args = p.parse_args()

    port, port_note = resolve_port(args.port)
    print(f"🔌 端口: {port_note}")
    try:
        rdp = RDP(args.host, port)
    except Exception as e:
        print(f"❌ 连不上 {args.host}:{port} —— {e}")
        print("   确认 run.sh 已启动、且端口是 web-ext 的 -start-debugger-server 端口。")
        sys.exit(1)

    try:
        if args.cmd == "tabs":
            cmd_tabs(rdp)
        elif args.cmd == "search":
            if not args.arg:
                print("❌ search 需要一个关键词，例如: list.py search 金币")
                sys.exit(1)
            cmd_search(rdp, args.arg)
        elif args.cmd == "class":
            if not args.arg:
                print("❌ class 需要一个子串，例如: list.py class topbar")
                sys.exit(1)
            cmd_class(rdp, args.arg)
        elif args.cmd == "sel":
            if not args.arg:
                print("❌ sel 需要一个 CSS 选择器，例如: list.py sel .gold-value")
                sys.exit(1)
            cmd_sel(rdp, args.arg)
        elif args.cmd == "text":
            if not args.arg:
                print("❌ text 需要一个 CSS 选择器")
                sys.exit(1)
            cmd_text(rdp, args.arg)
        elif args.cmd in RESOURCE_MAP:
            cmd_resource(rdp, args.cmd)
        else:
            print(f"❌ 未知命令: {args.cmd}")
            p.print_help()
            sys.exit(1)
    finally:
        rdp.s.close()


if __name__ == "__main__":
    main()
