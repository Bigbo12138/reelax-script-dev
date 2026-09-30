#!/usr/bin/env python3
# rdp_query.py —— 通过 Firefox 远程调试端口(RDP) 查询页面信息 / 执行页面 JS
#
# 背景：
#   web-ext run 会用 `-start-debugger-server <port>` 起一个 RDP 服务(老式远程调试协议)，
#   走原始 TCP，帧格式为 `<十进制长度>:<JSON>`。普通 curl / 浏览器 ws:// 连不上，
#   必须按 RDP 协议拆包。本脚本就是干这个的。
#
# 用法：
#   python3 rdp_query.py                  # 自动检测调试端口并列出标签页
#   python3 rdp_query.py --port 36353 list # 手动指定端口
#   python3 rdp_query.py eval "window.__reelaxLog.size()"   # 在第 1 个标签页执行 JS
#   python3 rdp_query.py eval --tab 1 "location.href"       # 指定第 N 个标签页(从 0 起)
#   python3 rdp_query.py info             # 打印服务端 traits
#
# 端口来源（优先级）：
#   1. 命令行 --port 显式指定
#   2. 自动检测：从运行中的 firefox 进程命令行 / web-ext 启动日志里找
#      -start-debugger-server 的端口（web-ext 每次启动端口都是随机的）
#   3. 兜底默认 36353
#
# 依赖：仅标准库(socket/json/subprocess/glob/re)，无需 pip 安装。

import argparse
import glob
import json
import re
import socket
import subprocess
import sys
import time

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 36353


def find_debug_port():
    """自动检测当前 web-ext 启动的 Firefox 调试端口；找不到返回 None。"""
    # 1) 从运行中的 firefox 进程命令行找 -start-debugger-server <port>
    try:
        out = subprocess.run(
            ["pgrep", "-af", "firefox"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in out.splitlines():
            m = re.search(r"-start-debugger-server\s+(\d+)", line)
            if m:
                return int(m.group(1))
    except Exception:
        pass
    # 2) 从 web-ext 启动日志里找 "Remote debugging port: N"（进程没了也能定位）
    try:
        logs = sorted(
            glob.glob("/home/ubuntu/Downloads/firefoxfish-launch-*.log"),
            reverse=True,
        )
        for path in logs[:3]:
            with open(path, encoding="utf-8", errors="ignore") as f:
                content = f.read()
            m = re.search(r"Remote debugging port:\s*(\d+)", content)
            if m:
                return int(m.group(1))
    except Exception:
        pass
    return None


def resolve_port(explicit_port):
    """按优先级解析端口：显式 > 自动检测 > 默认。返回 (port, 来源说明)。"""
    if explicit_port is not None:
        return explicit_port, f"手动指定 {explicit_port}"
    detected = find_debug_port()
    if detected is not None:
        return detected, f"自动检测到 {detected}"
    return DEFAULT_PORT, f"未检测到，回退默认 {DEFAULT_PORT}"


class RDP:
    """极简 RDP 客户端：<长度>:<JSON> 帧格式。"""

    def __init__(self, host, port):
        self.s = socket.create_connection((host, port), timeout=8)
        self.s.settimeout(8)

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.s.recv(n - len(buf))
            if not chunk:
                raise EOFError("连接被关闭")
            buf += chunk
        return buf

    def read_packet(self):
        head = b""
        while not head.endswith(b":"):
            head += self.s.recv(1)
        n = int(head[:-1])
        return json.loads(self._read_exact(n).decode("utf-8"))

    def send(self, obj):
        body = json.dumps(obj).encode("utf-8")
        self.s.sendall(f"{len(body)}:".encode() + body)

    def greeting(self):
        return self.read_packet()

    def read_until(self, predicate):
        """循环读取，直到 predicate(packet) 为真；跳过 null 包。"""
        while True:
            packet = self.read_packet()
            if packet is None:
                continue
            if predicate(packet):
                return packet

    def request(self, to, type_, extra=None):
        # 新版本 Firefox 的 RDP：部分命令会先回一个 `null` 占位，真实响应在后续包里；
        # 也可能夹带无关的推送事件。这里循环读取，直到拿到 `from == to` 的响应为止。
        msg = {"to": to, "type": type_}
        if extra:
            msg.update(extra)
        self.send(msg)
        while True:
            packet = self.read_packet()
            if packet is None:
                continue
            if packet.get("from") == to:
                return packet
            # 其它来源的推送(如 consoleAPICall / tabListChanged)先跳过


def list_tabs(rdp):
    g = rdp.greeting()
    tabs = rdp.request("root", "listTabs").get("tabs", [])
    print(f"✅ 已连接 Firefox (applicationType={g.get('applicationType')})")
    print(f"📋 共 {len(tabs)} 个标签页:\n")
    for i, t in enumerate(tabs):
        print(f"  [{i}] {t.get('title', '(无标题)')}")
        print(f"      actor: {t.get('actor')}")
        print(f"      url  : {t.get('url', '')}")
    return tabs


def show_info(rdp):
    g = rdp.greeting()
    print("📨 服务端问候:")
    print(json.dumps(g, indent=2, ensure_ascii=False))


def get_console_actor(rdp, tab):
    """拿到标签页的 console actor（兼容新旧 RDP / Fission）。"""
    # 旧版：consoleActor 直接在 tab 上
    if tab.get("consoleActor"):
        return tab["consoleActor"]
    # Fission/新 RDP：tab 是 descriptor，getTarget 返回的 frame 里带 consoleActor
    try:
        target = rdp.request(tab["actor"], "getTarget")
        frame = target.get("frame") or {}
        if frame.get("consoleActor"):
            return frame["consoleActor"]
        if target.get("consoleActor"):
            return target["consoleActor"]
    except Exception:
        pass
    return None


def eval_js(rdp, expr, tab_index):
    rdp.greeting()  # 先消费服务端主动发来的 greeting 包，否则首个 read 会读到它
    tabs = rdp.request("root", "listTabs").get("tabs", [])
    if not tabs:
        print("❌ 没有可调试的标签页")
        return
    if tab_index >= len(tabs):
        print(f"❌ tab 索引 {tab_index} 越界(共 {len(tabs)} 个)")
        return
    tab = tabs[tab_index]
    actor = get_console_actor(rdp, tab)
    if not actor:
        print(f"❌ 拿不到标签页的 consoleActor（tab={tab.get('actor')}）")
        return

    # 新版本 consoleActor 只认 evaluateJSAsync：先拿 resultId，再等 evaluationResult 包
    ack = rdp.request(actor, "evaluateJSAsync", {"text": expr})
    result_id = ack.get("resultID")
    if result_id is None:
        print(json.dumps(ack, ensure_ascii=False))
        return
    result_packet = rdp.read_until(
        lambda p: p.get("type") == "evaluationResult" and p.get("resultID") == result_id
    )

    if result_packet.get("exceptionMessage"):
        print("⚠️ 执行抛错:", result_packet["exceptionMessage"])
    result = result_packet.get("result")
    print(format_grip(result))


def grip_to_python(grip, _depth=0):
    """把 RDP 返回的 grip 递归还原成 Python 原生值。

    - 基础类型(string/number/boolean)→ 对应 Python 值
    - undefined/null → None
    - object/array → 优先用 preview.ownProperties 递归展开；没有 preview 时退回原始 grip
    """
    if grip is None:
        return None
    if not isinstance(grip, dict):
        return grip
    gtype = grip.get("type")
    if gtype in ("string", "number", "boolean"):
        return grip.get("value")
    if gtype == "undefined" or gtype == "null":
        return None
    if gtype in ("object", "array", None) and _depth < 12:
        preview = grip.get("preview")
        if isinstance(preview, dict):
            own = preview.get("ownProperties")
            if isinstance(own, dict):
                # 数组：ownProperties 用 "0","1",... 做 key
                keys = list(own.keys())
                if keys and all(k.isdigit() for k in keys):
                    arr = [grip_to_python(own[k].get("value"), _depth + 1) for k in sorted(keys, key=int)]
                    return arr
                result = {}
                for k, v in own.items():
                    result[k] = grip_to_python(v.get("value"), _depth + 1)
                return result
    return grip  # 对象/数组等，交给调用方处理


def format_grip(grip):
    """把 RDP 返回的 grip 结构尽量还原成可读文本。"""
    if grip is None:
        return "(null)"
    if not isinstance(grip, dict):
        return str(grip)
    gtype = grip.get("type")
    if gtype == "undefined":
        return "(undefined)"
    if "displayString" in grip:
        return grip["displayString"]
    if "value" in grip:
        return repr(grip["value"]) if isinstance(grip["value"], str) else str(grip["value"])
    # 对象类：尽量给 class + preview
    cls = grip.get("class") or grip.get("actor")
    preview = grip.get("preview", {})
    own = preview.get("ownProperties") or preview.get("ownPropertiesLength")
    if cls:
        return f"<{cls}>" + (f" {own}" if own else "")
    return json.dumps(grip, ensure_ascii=False)


def eval_js_async(rdp, expr, tab_index=0, timeout=20, result_var="__rdpAsync", js_file=None):
    """在页面里执行一个(可能是异步的)表达式，await 结果后返回 Python 值。

    Firefox 的 evaluateJSAsync 不会自动 await Promise(会回一个 pending 的 Promise grip)，
    所以这里把结果暂存到 window.<result_var>，再轮询读取，解决"异步表达式取不到值"的问题。
    expr 可以是普通表达式，也可以是返回 Promise 的(async()=>{...})()。
    js_file: 可选，先把该文件内容注入页面(如 sign.js 定义 window.__sign)，再执行 expr。
    """
    rdp.greeting()  # 消费服务端主动 greeting
    tabs = rdp.request("root", "listTabs").get("tabs", [])
    if not tabs:
        raise RuntimeError("没有可调试的标签页")
    if tab_index >= len(tabs):
        raise RuntimeError(f"tab 索引 {tab_index} 越界(共 {len(tabs)} 个)")
    actor = get_console_actor(rdp, tabs[tab_index])
    if not actor:
        raise RuntimeError("拿不到 consoleActor，无法执行 JS")

    # 可选：先注入 JS 文件(如 sign.js 定义 window.__sign)，用同步 evaluateJSAsync 即可
    if js_file:
        with open(js_file, encoding="utf-8") as f:
            file_code = f.read()
        ack = rdp.request(actor, "evaluateJSAsync", {"text": file_code})
        rid = ack.get("resultID")
        if rid is None:
            raise RuntimeError("注入文件失败: " + json.dumps(ack, ensure_ascii=False))
        rdp.read_until(lambda p: p.get("type") == "evaluationResult" and p.get("resultID") == rid)

    # 包一层 async，把结果(resolve 或 reject)写入 window.<result_var>；最终置 done 标志
    wrapped = (
        "(async()=>{"
        " try{ window." + result_var + " = await (" + expr + "); }"
        " catch(__e){ window." + result_var + " = {__error: String(__e)}; }"
        " finally{ window." + result_var + "Done = true; }"
        "})(); 'kicked';"
    )

    # 触发执行(返回值 'kicked' 是同步字符串，evaluateJSAsync 会正常回 evaluationResult)
    ack = rdp.request(actor, "evaluateJSAsync", {"text": wrapped})
    rid = ack.get("resultID")
    if rid is None:
        raise RuntimeError("evaluateJSAsync 未返回 resultID: " + json.dumps(ack, ensure_ascii=False))
    rdp.read_until(lambda p: p.get("type") == "evaluationResult" and p.get("resultID") == rid)

    # 轮询 window.<result_var>Done
    deadline = time.time() + timeout
    try:
        import time as _t
    except Exception:
        _t = time
    while _t.time() < deadline:
        ack = rdp.request(actor, "evaluateJSAsync", {"text": f"window.{result_var}Done===true"})
        rid = ack.get("resultID")
        if rid is None:
            break
        pkt = rdp.read_until(lambda p: p.get("type") == "evaluationResult" and p.get("resultID") == rid)
        if grip_to_python(pkt.get("result")) is True:
            break
        _t.sleep(0.25)

    # 读取结果
    ack = rdp.request(actor, "evaluateJSAsync", {"text": f"window.{result_var}"})
    rid = ack.get("resultID")
    if rid is None:
        return None
    pkt = rdp.read_until(lambda p: p.get("type") == "evaluationResult" and p.get("resultID") == rid)
    return grip_to_python(pkt.get("result"))


def main():
    p = argparse.ArgumentParser(description="通过 RDP 端口查询 Firefox 页面信息")
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--port", type=int, default=None,
                   help="调试端口；缺省时自动检测 web-ext 的 -start-debugger-server 端口")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("list", help="列出所有标签页(默认)")
    sub.add_parser("info", help="打印服务端 traits")
    ev = sub.add_parser("eval", help="在页面里执行 JS 表达式(同步值/不 await Promise)")
    ev.add_argument("expr", help="JS 表达式，例如 window.__reelaxLog.size()")
    ev.add_argument("--tab", type=int, default=0, help="第几个标签页(从 0 起，默认 0)")
    eva = sub.add_parser("evala", help="执行(可能是异步的)JS 表达式，await 结果再返回")
    eva.add_argument("expr", help="JS 表达式，可返回 Promise，例如 (async()=>{...})()")
    eva.add_argument("--tab", type=int, default=0, help="第几个标签页(从 0 起，默认 0)")
    eva.add_argument("--timeout", type=float, default=20, help="异步结果等待超时(秒)")
    eva.add_argument("--js-file", default=None,
                     help="先注入该 JS 文件(如 devtools/sign.js 定义 window.__sign)，再执行表达式")

    args = p.parse_args()
    port, port_note = resolve_port(args.port)
    print(f"🔌 端口: {port_note}")
    try:
        rdp = RDP(args.host, port)
    except Exception as e:
        print(f"❌ 连不上 {args.host}:{port} —— {e}")
        print("   确认 run.sh 已启动、且端口是 web-ext 的 -start-debugger-server 端口。")
        sys.exit(1)

    cmd = args.cmd or "list"
    if cmd == "list":
        list_tabs(rdp)
    elif cmd == "info":
        show_info(rdp)
    elif cmd == "eval":
        eval_js(rdp, args.expr, args.tab)
    elif cmd == "evala":
        import time as _t
        t0 = _t.time()
        out = eval_js_async(rdp, args.expr, args.tab, timeout=args.timeout, js_file=args.js_file)
        print(format_grip(out) if not isinstance(out, str) else out)
        if isinstance(out, dict) and "__error" in out:
            print("⚠️ 异步执行抛错:", out["__error"])
    rdp.s.close()


if __name__ == "__main__":
    main()
