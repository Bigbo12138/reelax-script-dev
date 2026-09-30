#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ws_bridge.py —— 持久 WebSocket 桥（替代原 HTTP 长轮询桥）
#
# 架构：
#   1. 本模块在本机 127.0.0.1:WS_PORT 起一个 WebSocket 服务端（纯标准库实现 RFC6455）。
#   2. 扩展后台 bridge.js 作为 WebSocket 客户端主动连上，保持长连接 + 快速重连（≤3s）。
#   3. Python 侧通过 request() 下发 {id, method, path, body}，扩展在页面上下文
#      签名执行后回传 {id, status, ok, data, raw}。全双工、无轮询竞态。
#
# 双模式（多进程共存）：
#   - 服务端模式：进程绑定 WS_PORT 并常驻，自己负责转发（market 长驻脚本用）。
#   - 客户端模式：端口已被别的进程占用时自动降级为控制器客户端，连上去发请求
#     收响应（一次性 CLI 与常驻服务并存）。
#
# 用法（作为库）：
#   import ws_bridge
#   ws_bridge.start(port=55004)          # 后台线程起服务（或自动降级客户端模式）
#   r = ws_bridge.request('/api/me', 'GET')  # 阻塞等待扩展回传
#
# CLI：python3 ws_bridge.py serve --port 55004

import asyncio
import base64
import hashlib
import json
import struct
import threading
import time
import uuid

# Windows GBK 控制台无法编码 🟢 等非 ASCII 字符，导致 print 抛 UnicodeEncodeError。
# 强制 stdout/stderr 用 UTF-8 输出（errors='replace' 兜底），保证带 emoji 的日志不崩。
try:
    import sys
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

WS_HOST = "0.0.0.0"   # 0.0.0.0 让 55004(WS桥+交易大屏) 可从局域网/外网访问
WS_PORT = 55004
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CONNECT_WAIT_S = 6   # 服务端模式：等待扩展连上来的最大秒数
EXT_READ_TIMEOUT = 30  # 等扩展响应超时
CONN_IDLE_TIMEOUT = 60  # 单次读帧超时：超过 60s 无任何帧 → 判定连接已死并清理

_loop = None            # asyncio 事件循环（服务端模式专属）
_clients = set()        # 已连接的连接集合（扩展 + 控制器）
_pending = {}           # request id -> asyncio.Future
_mode = None            # 'server' | 'client'
_port = None

# 市场实时事件缓存（交易大屏数据源）。扩展 market_events.js 推送的每条 market-event
# 都会进此队列（上限 MARKET_CACHE_MAX），大屏后端可随时拉取最近 N 条。
MARKET_CACHE_MAX = 500
_market_cache = []       # list[dict]：最近的 market-event（最新在尾部）
_market_cache_lock = threading.Lock()


# 鱼价历史（大屏走势线）。order-book-updated 事件记录：fishId -> [(ts, {unitPrice:qty}), ...]
_fish_price_history = {}
_fish_price_history_max = 60
_fish_hist_lock = threading.Lock()


def _push_fish_history(fish_id, sell_levels, ts=None):
    """记录一条鱼的价格历史快照（供走势线）。"""
    import time as _t
    if not fish_id:
        return
    ts = ts or int(_t.time() * 1000)
    levels = {}
    for s in (sell_levels or []):
        if s and s.get('unitPrice'):
            levels[int(s['unitPrice'])] = int(s.get('quantity', 0))
    if not levels:
        return
    with _fish_hist_lock:
        hist = _fish_price_history.setdefault(fish_id, [])
        # 相同价格组合去重（仅当价格分布变化才记一条，避免刷屏）
        if hist and hist[-1][1] == levels:
            return
        hist.append((ts, levels))
        if len(hist) > _fish_price_history_max:
            del hist[:len(hist) - _fish_price_history_max]


def _get_fish_history(fish_id, n=60):
    with _fish_hist_lock:
        hist = _fish_price_history.get(fish_id, [])
        return hist[-n:][::-1]


def _all_fish_history_snapshot(n=60):
    """返回所有鱼的价格历史快照（最新在前）。"""
    with _fish_hist_lock:
        return {fid: hist[-n:][::-1] for fid, hist in _fish_price_history.items()}


def _fp_module():
    import importlib.util
    import os as _os
    _p = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'fish_prices.py')
    try:
        _spec = importlib.util.spec_from_file_location('fish_prices_live', _p)
        _m = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_m)
        return _m
    except Exception:
        return None


def _record_fish_price_history(fish_id, sell_levels, occurred_at=None):
    ts = None
    if isinstance(occurred_at, int):
        ts = occurred_at
    elif occurred_at:
        try:
            import datetime
            dt = datetime.datetime.fromisoformat(str(occurred_at).replace('Z', '+00:00'))
            ts = int(dt.timestamp() * 1000)
        except Exception:
            ts = None
    _push_fish_history(fish_id, sell_levels, ts)


def _push_market_event(msg):
    """写入内存缓存（大屏拉取）+ 记录 order-book 价格历史。"""
    with _market_cache_lock:
        _market_cache.append(msg)
        if len(_market_cache) > MARKET_CACHE_MAX:
            del _market_cache[:len(_market_cache) - MARKET_CACHE_MAX]
        _broadcast_market_to_http(msg)
    try:
        d = msg.get('data') or {}
        ev = d.get('ev') if isinstance(d, dict) else None
        if ev and ev.get('type') == 'order-book-updated' and ev.get('fishId'):
            _record_fish_price_history(ev.get('fishId'), ev.get('sellLevels') or [], ev.get('occurredAt'))
    except Exception:
        pass


def market_cache_snapshot(n=None):
    """返回最近 n 条市场事件（最新在前）；n=None 返回全部。"""
    with _market_cache_lock:
        items = list(_market_cache)
    if n is not None and n > 0:
        items = items[-n:]
    return items


def market_cache_clear():
    with _market_cache_lock:
        _market_cache.clear()


def _b64url_rand():
    return base64.urlsafe_b64encode(uuid.uuid4().bytes).decode().rstrip('=')


class WsConn:
    """一条 WebSocket 连接（读写帧）。"""

    def __init__(self, reader, writer, is_client=False):
        self.reader = reader
        self.writer = writer
        self.closed = False
        self.is_client = is_client  # True=本进程是客户端(连接外部服务端)

    # ---------- 服务端握手（等客户端发起）----------
    # 返回 (is_websocket, request)：
    #   is_websocket=True  → 已是 WS 升级连接（已回 101），request 为 None
    #   is_websocket=False → 普通 HTTP 请求（未回响应），request 为 {method, path, headers, query}
    async def server_handshake(self):
        data = await self.reader.readuntil(b"\r\n\r\n")
        lines = data.decode("latin1").split("\r\n")
        request_line = lines[0] if lines else ""
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        parts = request_line.split(" ")
        method = parts[0] if len(parts) > 0 else "GET"
        target = parts[1] if len(parts) > 1 else "/"
        key = headers.get("sec-websocket-key", "")
        if key:
            accept = base64.b64encode(
                hashlib.sha1((key + WS_MAGIC).encode("latin1")).digest()
            ).decode("ascii")
            self.writer.write(
                ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                 "Connection: Upgrade\r\n"
                 f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode("latin1"))
            await self.writer.drain()
            return True, None
        path = target.split("?", 1)[0]
        query = {}
        if "?" in target:
            for kv in target.split("?", 1)[1].split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    query[k] = v
        return False, {"method": method.upper(), "path": path, "headers": headers, "query": query}

    # ---------- 客户端握手（主动连服务端）----------
    async def client_handshake(self):
        key = _b64url_rand()
        self.writer.write((
            f"GET / HTTP/1.1\r\nHost: {WS_HOST}:{_port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode("latin1"))
        await self.writer.drain()
        await self.reader.readuntil(b"\r\n\r\n")

    # ---------- 读一帧（客户端帧带 mask，服务端帧不带）----------
    async def read_frame(self):
        hdr = await self.reader.readexactly(2)
        opcode = hdr[0] & 0x0F
        masked = hdr[1] & 0x80
        length = hdr[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", await self.reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", await self.reader.readexactly(8))[0]
        mask = await self.reader.readexactly(4) if masked else None
        payload = await self.reader.readexactly(length)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    # ---------- 发送文本帧 ----------
    def send_text(self, text, masked=False):
        if self.closed:
            return
        payload = text.encode("utf-8")
        if masked:
            mask = b'\x01\x02\x03\x04'
            body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        else:
            body = payload
        length = len(body)
        if length < 126:
            header = bytes([0x81, (0x80 if masked else 0) | length])
        elif length < 65536:
            header = bytes([0x81, (0x80 if masked else 0) | 126]) + struct.pack(">H", length)
        else:
            header = bytes([0x81, (0x80 if masked else 0) | 127]) + struct.pack(">Q", length)
        if masked:
            header += mask
        try:
            self.writer.write(header + body)
        except Exception:
            self.closed = True

    async def close(self):
        self.closed = True
        try:
            self.writer.close()
        except Exception:
            pass



# ---------- 交易大屏 HTTP（与 WebSocket 桥同端口复用）----------
# 55004 同一端口：WebSocket 升级走桥协议，普通 HTTP GET 走大屏页面/API。
# 数据源 = market_events.js 订阅 SSE → bridge.js → 本进程 market-event 广播（_push_market_event）。
# 路径：
#   GET /                       → 大屏 HTML
#   GET /bigscreen              → 大屏 HTML
#   GET /bigscreen/api/history  → JSON：最近 N 条市场事件 + 统计
#   GET /bigscreen/api/stream   → SSE 实时推送市场事件

_BIGSCREEN_HTML = None
_http_subs = set()   # SSE 订阅者（asyncio.Queue）

def _load_bigscreen_html():
    global _BIGSCREEN_HTML
    if _BIGSCREEN_HTML is None:
        import os
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'market_bigscreen.html')
        try:
            with open(p, encoding='utf-8') as f:
                _BIGSCREEN_HTML = f.read()
        except Exception:
            _BIGSCREEN_HTML = '<h1>Bigscreen HTML not found</h1>'
    return _BIGSCREEN_HTML


# ---------- 挂机日报 HTTP（GET / 首页）----------
# 55004 首页改成「挂机日报 / 体检中心」：GET / 返回日报页面，
# GET /report/api/daily 返回生成的 daily_report.json，POST /report/api/trigger 手动重生成。
# 市场大屏挪到 /bigscreen 保留。数据源 = data/daily_report.json（gaming/daily_report.py 生成）。

_DAILY_REPORT_HTML = None

def _report_dir():
    import os
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')


def _load_daily_report_html():
    global _DAILY_REPORT_HTML
    if _DAILY_REPORT_HTML is None:
        import os
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'daily_report.html')
        try:
            with open(p, encoding='utf-8') as f:
                _DAILY_REPORT_HTML = f.read()
        except Exception:
            _DAILY_REPORT_HTML = '<h1>daily_report.html not found</h1>'
    return _DAILY_REPORT_HTML


def _load_daily_report_json():
    import os
    p = os.path.join(_report_dir(), 'daily_report.json')
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'error': 'report-not-generated', 'hint': '先运行 python3 gaming/daily_report.py --gen --demo 或用 POST /report/api/trigger 生成'}


def _trigger_daily_report():
    """同步调用 daily_report.py --gen 生成日报；成功返回 True。"""
    import os
    import subprocess
    import sys
    # 生成前先做每日0点滚动：确保 daily_raw.json 已是今天（否则 daily_report.py 会把昨天数据标成今天）。
    try:
        _ensure_daily_today_rolled()
    except Exception:
        pass
    try:
        py = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gaming', 'daily_report.py')
        r = subprocess.run([sys.executable, py, '--gen', '--json'], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, r.stdout[-500:] if r.returncode != 0 else ''
    except Exception as e:
        return False, str(e)


def _broadcast_market_to_http(msg):
    if not _http_subs:
        return
    try:
        data = msg.get('data', msg)
        entry = {'src': msg.get('src', 'fish'), 'at': msg.get('at', 0),
                 'type': data.get('type', '') if isinstance(data, dict) else '',
                 'data': data}
    except Exception:
        return
    for q in list(_http_subs):
        try:
            q.put_nowait(entry)
        except Exception:
            pass


def _broadcast_daily_to_http(data):
    """挂机日报实时数据广播：monitor 推 daily_raw → 广播给 /report/api/stream 订阅者。"""
    if not _http_subs or not data:
        return
    entry = {'src': 'daily', 'at': int(time.time() * 1000), 'type': 'daily-report', 'data': data}
    for q in list(_http_subs):
        try:
            q.put_nowait(entry)
        except Exception:
            pass


async def _http_write(writer, status, ctype, body, extra=None):
    CRLF = '\r\n'
    reason = {200: 'OK', 404: 'Not Found', 500: 'Internal Server Error'}.get(status, 'OK')
    head = 'HTTP/1.1 %d %s%s' % (status, reason, CRLF)
    head += 'Content-Type: ' + ctype + CRLF
    head += 'Access-Control-Allow-Origin: *' + CRLF
    head += 'Connection: close' + CRLF
    if extra:
        for k, v in extra.items():
            head += '%s: %s%s' % (k, v, CRLF)
    head += 'Content-Length: %d%s%s' % (len(body), CRLF, CRLF)
    writer.write(head.encode('latin1') + body)
    await writer.drain()


async def _handle_http(req, reader, writer):
    path = req.get('path', '/')
    method = req.get('method', 'GET')
    # 首页 → 挂机日报（市场大屏挪到 /bigscreen）
    if path == '/' or path == '/daily' or path == '/report':
        body = _load_daily_report_html().encode('utf-8')
        await _http_write(writer, 200, 'text/html; charset=utf-8', body)
        writer.close()
        await writer.wait_closed()
        return
    # 日报数据 / 手动重生成
    if path == '/report/api/daily':
        payload = json.dumps(_load_daily_report_json(), ensure_ascii=False).encode('utf-8')
        await _http_write(writer, 200, 'application/json; charset=utf-8', payload)
        writer.close()
        await writer.wait_closed()
        return
    if path == '/report/api/stream':
        # SSE：实时推送 monitor 推的 daily_raw（在线/保底/杆数/出货等）
        CRLF = '\r\n'
        writer.write(('HTTP/1.1 200 OK' + CRLF +
                      'Content-Type: text/event-stream' + CRLF +
                      'Cache-Control: no-cache' + CRLF +
                      'Access-Control-Allow-Origin: *' + CRLF +
                      'Connection: keep-alive' + CRLF + CRLF).encode('latin1'))
        await writer.drain()
        # 先推一份当前已有数据（若已生成）
        cur = _load_daily_report_json()
        if cur and 'error' not in cur:
            writer.write(('data: ' + json.dumps({'src':'daily','at':int(time.time()*1000),'type':'report','data':cur}, ensure_ascii=False) + '\n\n').encode('utf-8'))
            await writer.drain()
        q = asyncio.Queue()
        _http_subs.add(q)
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    writer.write(('data: ' + json.dumps(msg, ensure_ascii=False) + '\n\n').encode('utf-8'))
                    await writer.drain()
                except asyncio.TimeoutError:
                    writer.write(b': ping\n\n')
                    await writer.drain()
        except Exception:
            pass
        finally:
            _http_subs.discard(q)
            writer.close()
            await writer.wait_closed()
        return
    if path == '/report/api/trigger':
        # 后台线程执行 daily_report.py --gen（避免阻塞事件循环，周赛/上杆要连回桥拉数据）
        ok, msg = await asyncio.to_thread(_trigger_daily_report)
        payload = json.dumps({'ok': ok, 'msg': msg}, ensure_ascii=False).encode('utf-8')
        await _http_write(writer, 200 if ok else 500, 'application/json; charset=utf-8', payload)
        writer.close()
        await writer.wait_closed()
        return
    if path == '/bigscreen' or path == '/bigscreen/':
        body = _load_bigscreen_html().encode('utf-8')
        await _http_write(writer, 200, 'text/html; charset=utf-8', body)
        writer.close()
        await writer.wait_closed()
        return
    if path == '/bigscreen/api/history':
        items = market_cache_snapshot(200)
        events = []
        for it in items:
            data = it.get('data', it)
            events.append({'src': it.get('src', 'fish'), 'at': it.get('at', 0),
                           'type': data.get('type', '') if isinstance(data, dict) else '',
                           'data': data})
        payload = json.dumps({'events': events}, ensure_ascii=False).encode('utf-8')
        await _http_write(writer, 200, 'application/json; charset=utf-8', payload)
        writer.close()
        await writer.wait_closed()
        return
    if path == '/bigscreen/api/stream':
        CRLF = '\r\n'
        writer.write(('HTTP/1.1 200 OK' + CRLF +
                      'Content-Type: text/event-stream' + CRLF +
                      'Cache-Control: no-cache' + CRLF +
                      'Access-Control-Allow-Origin: *' + CRLF +
                      'Connection: keep-alive' + CRLF + CRLF).encode('latin1'))
        await writer.drain()
        items = market_cache_snapshot(30)
        for it in items:
            data = it.get('data', it)
            line = json.dumps({'src': it.get('src', 'fish'), 'at': it.get('at', 0),
                               'type': data.get('type', '') if isinstance(data, dict) else '',
                               'data': data}, ensure_ascii=False)
            writer.write(('data: ' + line + '\n\n').encode('utf-8'))
        await writer.drain()
        q = asyncio.Queue()
        _http_subs.add(q)
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    writer.write(('data: ' + json.dumps(msg, ensure_ascii=False) + '\n\n').encode('utf-8'))
                    await writer.drain()
                except asyncio.TimeoutError:
                    writer.write(b': ping\n\n')
                    await writer.drain()
        except Exception:
            pass
        finally:
            _http_subs.discard(q)
            writer.close()
            await writer.wait_closed()
        return
    if path == '/bigscreen/api/fish-prices':
        import os as _os
        # ---- 原实现（从 fish_snapshot.json 扫描快照读，已停用定时扫描，改用 SSE 实时历史）----
        # _fp = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'fish_prices.py')
        # snap = {}
        # _snap_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'fish_snapshot.json')
        # try:
        #     with open(_snap_path, encoding='utf-8') as _f:
        #         snap = json.load(_f)
        # except Exception:
        #     snap = {'fish': [], 'count': 0}
        # snap['history'] = {}
        # for _f in snap.get('fish', []):
        #     _fid = _f.get('fishId')
        #     if _fid:
        #         _h = _get_fish_history(_fid)
        #         if _h:
        #             snap['history'][_fid] = _h
        # ---- 新实现：只读静态鱼名表(最后一次扫描)，盘口用 SSE 实时历史 ----
        snap = {'fish': [], 'count': 0, 'history': {}}
        # 静态鱼名表（来自最后一次 fish_prices 扫描，仅提供 fishId->name 映射）
        _snap_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'fish_snapshot.json')
        _name_map = {}
        try:
            with open(_snap_path, encoding='utf-8') as _f:
                _old = json.load(_f)
            for _f0 in _old.get('fish', []):
                if _f0.get('fishId'):
                    _name_map[_f0['fishId']] = {'name': _f0.get('name'), 'rarity': _f0.get('rarity'), 'sellPrice': _f0.get('sellPrice')}
        except Exception:
            _name_map = {}
        # 用 SSE 实时记录的价格历史构建每条鱼的当前盘口
        _all = _all_fish_history_snapshot()
        for _fid, _hist in _all.items():
            if not _hist:
                continue
            _latest = _hist[0][1]   # 最新快照的 {unitPrice:qty}
            _sell = [{'unitPrice': int(p), 'quantity': q} for p, q in sorted(_latest.items())]
            _meta = _name_map.get(_fid, {})
            snap['fish'].append({
                'fishId': _fid,
                'name': _meta.get('name'),
                'rarity': _meta.get('rarity'),
                'sellPrice': _meta.get('sellPrice'),
                'sellLevels': _sell,
                'buyLevels': [],
                'quantity': 0,
                'latestTradeUnitPrice': None,
                'priceChange24hBp': None,
            })
            snap['history'][_fid] = _hist
        snap['count'] = len(snap['fish'])
        payload = json.dumps(snap, ensure_ascii=False).encode('utf-8')
        await _http_write(writer, 200, 'application/json; charset=utf-8', payload)
        writer.close()
        await writer.wait_closed()
        return
    if path == '/bigscreen/api/fish-ids':
        import os as _os
        # ---- 原实现（从 fish_snapshot.json 读，已停用扫描）----
        # _ids = []
        # _snap_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'fish_snapshot.json')
        # try:
        #     with open(_snap_path, encoding='utf-8') as _f:
        #         _snap = json.load(_f)
        #     _ids = [f.get('fishId') for f in _snap.get('fish', []) if f.get('fishId')]
        # except Exception:
        #     _ids = []
        # ---- 新实现：从 SSE 实时历史读有盘口数据的鱼 ----
        _ids = list(_all_fish_history_snapshot().keys())
        payload = json.dumps({'fishIds': _ids, 'count': len(_ids)}, ensure_ascii=False).encode('utf-8')
        await _http_write(writer, 200, 'application/json; charset=utf-8', payload)
        writer.close()
        await writer.wait_closed()
        return
    if path.startswith('/static/'):
        import os as _os
        _fname = path[len('/static/'):]
        _fpath = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'static', _fname)
        if _os.path.isfile(_fpath):
            try:
                with open(_fpath, 'rb') as _sf:
                    _data = _sf.read()
                _ctype = 'application/javascript' if _fname.endswith('.js') else 'application/octet-stream'
                _CRLF = chr(13) + chr(10)
                _head = 'HTTP/1.1 200 OK' + _CRLF + 'Content-Type: ' + _ctype + _CRLF + 'Access-Control-Allow-Origin: *' + _CRLF + 'Connection: close' + _CRLF + 'Content-Length: ' + str(len(_data)) + _CRLF + _CRLF
                writer.write(_head.encode('latin1') + _data)
                await writer.drain()
                writer.close()
                await writer.wait_closed()
                return
            except Exception:
                pass
        body = b'{"error":"static not found"}'
        await _http_write(writer, 404, 'application/json', body)
        writer.close()
        await writer.wait_closed()
        return
    body = b'{"error":"not found"}'
    await _http_write(writer, 404, 'application/json', body)
    writer.close()
    await writer.wait_closed()


# ---------- 服务端 ----------

def _ensure_daily_today_rolled():
    """【每日0点滚动】读 data/daily_raw.json，若其日期早于今天(昨天/更早残留)，就地改成今天的空档。

    这是「每天 0 点检查」的始终在线兜底（Python 桥不休眠、不依赖扩展 SW/WS 时序）：
    即使扩展在午夜后没及时推送 (SW 打盹 / WS 断开)，只要生成或读取日报前碰一下这里，
    桥的 daily_raw.json 就会先 roll 到今天，daily_report.py 就不会读到昨天的在线时长/出货。
    扩展后续的正常 tick 会用当天实时数据覆盖本空档。"""
    import json
    import os as _os
    from datetime import datetime
    _root = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
    p = _os.path.join(_root, 'data', 'daily_raw.json')
    if not _os.path.isfile(p):
        return
    try:
        with open(p, encoding='utf-8') as f:
            d = json.load(f)
    except Exception:
        return
    # 定位档内日期：顶层 date 或 raw.date
    raw = d if isinstance(d, dict) else {}
    date_val = raw.get('date')
    if isinstance(raw.get('raw'), dict) and raw['raw'].get('date'):
        date_val = raw['raw']['date']
    today = datetime.now().strftime('%Y%m%d')
    if date_val is not None and str(date_val) != today:
        fresh = {
            'date': today,
            'startedAt': int(datetime.now().timestamp() * 1000),
            'activeSec': 0, 'offlineSec': 0,
            'refillOk': 0, 'refillNeeded': 0,
            'switchOk': 0, 'switchTry': 0,
            'totalCasts': 0, 'dailyNetGold': 0,
            'rareCatches': {'exotic': 0, 'arcane': 0},
            'lastTickAt': int(datetime.now().timestamp() * 1000),
        }
        data = dict(fresh)
        # 保留原有外层 {raw, player, updatedAt} 结构（若原档如此），player 只读不动
        if 'raw' in raw or 'player' in raw:
            data = {'player': raw.get('player') or {}, 'raw': fresh, 'updatedAt': int(datetime.now().timestamp() * 1000)}
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        _os.replace(tmp, p)
        print(f"[daily] 跨天滚动: daily_raw.json 从 {date_val} → {today}（清空旧档）")


def _save_daily_raw(msg):
    """monitor 推送的当日原始数据 → 写 data/daily_raw.json（原子替换，不产生副本）。
    扩展端 dailyWriteFile 发的是 {updatedAt, raw, player}（gaming/daily_report.py 读 raw/player），
    bridge.js 透传后顶层就是这些键。旧逻辑误读 msg['data'] 导致写空 {}，这里取整条 payload
    （去掉 type 字段）；若确实没有 raw/player 再退回 msg['data'] 兜底。"""
    try:
        import os as _os
        data = dict(msg)
        data.pop('type', None)
        # 兜底：万一扩展端把数据放在 data 子字段
        if not any(k in data for k in ('raw', 'player', 'activeSec', 'totalCasts')) and isinstance(msg.get('data'), dict):
            data = msg['data']
        _root = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
        p = _os.path.join(_root, 'data', 'daily_raw.json')
        _os.makedirs(_os.path.dirname(p), exist_ok=True)
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        _os.replace(tmp, p)
        # 广播给 SSE 订阅者（页面实时显示）
        _broadcast_daily_to_http(data)
        print(f"[daily] 已写 daily_raw.json: totalCasts={data.get('raw', {}).get('totalCasts') if isinstance(data.get('raw'), dict) else data.get('totalCasts')}")
        return True
    except Exception as e:
        print('write daily_raw failed:', e)
        return False


async def _handle_conn(reader, writer):
    conn = WsConn(reader, writer)
    peer = writer.get_extra_info('peername')
    try:
        is_ws, http_req = await conn.server_handshake()
        if not is_ws:
            # 普通 HTTP 请求 → 大屏页面/API（WebSocket 桥之外的多协议复用）
            try:
                await _handle_http(http_req, reader, writer)
            except Exception:
                pass
            return
        _clients.add(conn)
        print(f"🔗 扩展已连接: {peer}")
        while True:
            # 读帧带超时：超过 CONN_IDLE_TIMEOUT 无任何帧 → 判定连接已死
            # （半开 TCP 连接不会发 FIN，read_frame 会永久阻塞，必须加超时清理）
            try:
                opcode, payload = await asyncio.wait_for(
                    conn.read_frame(), timeout=CONN_IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                print(f"⏰ 连接空闲超时({CONN_IDLE_TIMEOUT}s)，清理: {peer}")
                break
            if opcode == 0x8:  # close
                break
            if opcode == 0x9:  # ping → pong
                try:
                    writer.write(bytes([0x8A, len(payload)]) + payload)
                    await writer.drain()
                except Exception:
                    break
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode != 0x1:
                continue
            try:
                msg = json.loads(payload.decode("utf-8"))
            except Exception:
                continue

            # 应用层心跳：扩展发 {type:'ping'} → 回 {type:'pong'}
            if isinstance(msg, dict) and msg.get("type") == "ping":
                conn.send_text(json.dumps({"type": "pong", "ts": int(time.time() * 1000)}))
                continue
            # 市场实时事件（扩展 market_events.js → bridge.js 推送）→ 广播给大屏客户端，
            # 不参与请求-响应；同时维护内存缓存供大屏后端拉取。
            if isinstance(msg, dict) and msg.get("type") == "market-event":
                _push_market_event(msg)
                _broadcast(msg, exclude=conn)

                continue
            # 挂机日报：monitor → bridge → ws_bridge 写 data/daily_raw.json
            if isinstance(msg, dict) and msg.get("type") == "daily-report-raw":
                _save_daily_raw(msg)
                continue
            if not isinstance(msg, dict) or msg.get("id") is None:
                continue
            if "method" in msg:
                # 控制器/本进程下发的请求 → 转给扩展（其它连接），等回包后回给发起方
                resp = await _forward(msg, exclude=conn)
                conn.send_text(json.dumps(resp, ensure_ascii=False))
            else:
                # 扩展回包 → 按 id 唤醒等待者
                rid = msg.get("id")
                fut = _pending.pop(rid, None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
    except Exception:
        pass
    finally:
        _clients.discard(conn)
        await conn.close()
        print(f"🔌 连接断开: {peer}")


def _broadcast(msg, exclude=None):
    payload = json.dumps(msg, ensure_ascii=False)
    for c in list(_clients):
        if c is exclude:
            continue
        c.send_text(payload)


async def _forward(msg, exclude=None):
    rid = msg["id"]
    fut = _loop.create_future()
    _pending[rid] = fut
    out = {"id": rid, "method": msg["method"], "path": msg["path"]}
    if "body" in msg:
        out["body"] = msg["body"]
    _broadcast(out, exclude=exclude)
    try:
        return await asyncio.wait_for(fut, msg.get("timeout", EXT_READ_TIMEOUT))
    except asyncio.TimeoutError:
        return {"id": rid, "status": 0, "ok": False, "error": "bridge-timeout(扩展响应超时)"}
    finally:
        _pending.pop(rid, None)


def _run_server(port):
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)

    async def serve():
        server = await asyncio.start_server(_handle_conn, WS_HOST, port)
        print(f"🟢 WS 桥已就绪: ws://{WS_HOST}:{port}（服务端模式）")
        await server.serve_forever()

    _loop.run_until_complete(serve())


def _server_request(method, path, body, timeout):
    """服务端模式：等扩展连上（≤CONNECT_WAIT_S）后广播请求并等回包。"""
    waited = 0.0
    while not _clients and waited < CONNECT_WAIT_S:
        time.sleep(0.2)
        waited += 0.2
    if not _clients:
        return {"status": 0, "ok": False, "error": "扩展未连接（确认已启动 run.sh 并加载扩展）"}
    rid = str(uuid.uuid4())
    msg = {"id": rid, "method": method or "GET", "path": path, "timeout": timeout}
    if body is not None:
        msg["body"] = body
    coro = _forward(msg)
    fut = asyncio.run_coroutine_threadsafe(coro, _loop)
    try:
        return fut.result(timeout + 5)
    except Exception:
        return {"id": rid, "status": 0, "ok": False, "error": "bridge-error"}


# ---------- 客户端模式（端口被占用时降级）----------

async def _client_request(method, path, body, timeout):
    reader, writer = await asyncio.open_connection("127.0.0.1", _port)
    conn = WsConn(reader, writer, is_client=True)
    try:
        await conn.client_handshake()
        rid = str(uuid.uuid4())
        msg = {"id": rid, "method": method or "GET", "path": path}
        if body is not None:
            msg["body"] = body
        conn.send_text(json.dumps(msg, ensure_ascii=False), masked=True)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = max(1, deadline - time.monotonic())
            try:
                opcode, payload = await asyncio.wait_for(conn.read_frame(), remaining)
            except asyncio.TimeoutError:
                break
            if opcode != 0x1:
                continue
            try:
                resp = json.loads(payload.decode("utf-8"))
            except Exception:
                continue
            # 跳过心跳 pong 消息
            if isinstance(resp, dict) and resp.get("type") == "pong":
                continue
            if resp.get("id") == rid:
                return resp
        return {"id": rid, "status": 0, "ok": False, "error": "bridge-timeout"}
    except asyncio.TimeoutError:
        return {"status": 0, "ok": False, "error": "bridge-timeout"}
    except Exception as e:
        return {"status": 0, "ok": False, "error": str(e)}
    finally:
        await conn.close()


def request(method, path, body=None, timeout=20):
    """阻塞下发一条请求并等扩展回传。返回 {id, status, ok, data, raw, error?}。"""
    global _mode, _loop
    if _mode == "server":
        return _server_request(method, path, body, timeout)
    if _mode == "client":
        return asyncio.run(_client_request(method, path, body, timeout))
    raise RuntimeError("ws_bridge 未启动，先调用 ws_bridge.start()")


def start(port=WS_PORT):
    """后台线程起服务端；端口被占用则降级为客户端模式。幂等。"""
    global _mode, _port
    _port = port
    if _mode is not None:
        return _mode
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((WS_HOST, port))
        s.close()
    except OSError:
        s.close()
        _mode = "client"
        print(f"🔌 端口 {port} 已被占用，降级为客户端模式（连接现有服务端）")
        return _mode
    _mode = "server"
    t = threading.Thread(target=_run_server, args=(port,), daemon=True)
    t.start()
    # 等端口真正起来。探测用回环 127.0.0.1（服务端绑定 0.0.0.0，但向 0.0.0.0 发包在 Windows
    # 上不可靠），否则端口起好也会误判失败并 raise RuntimeError，导致主线程退出、服务端被杀。
    probe_host = "127.0.0.1"
    for _ in range(60):
        try:
            with socket.create_connection((probe_host, port), timeout=0.3):
                return _mode
        except OSError:
            time.sleep(0.05)
    raise RuntimeError(f"WS 桥起不来: {WS_HOST}:{port}")


def connected():
    return bool(_clients)


def pending_count():
    return len(_pending)


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="持久 WebSocket 桥（扩展侧客户端连入）")
    p.add_argument("--port", type=int, default=WS_PORT)
    args = p.parse_args()
    start(port=args.port)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
