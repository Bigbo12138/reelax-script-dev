# -*- coding: utf-8 -*-
# fish_prices.py —— 背包鱼价格扫描 + 价格历史（交易大屏数据源）🍊
# 扫描背包鱼，对每条鱼拉 market order-book，聚合：
#   - 各种卖价档（玩家自定）、买价档、NPC回收价(sellPrice)
#   - 24h 涨跌、最新成交价（market-fish-overview）
#   - 价格历史（每次盘口变化记录，供走势线）
# 纯标准库 + WS 桥（api.py）。

import json
import os
import sys
import time
import threading

# 背包鱼价格历史（按 fishId 存 {ts, sellLevels} 快照），供大屏走势线
FISH_PRICE_HISTORY = {}      # fishId -> [(ts, {unitPrice: quantity}), ...]
FISH_PRICE_HISTORY_MAX = 50  # 每条鱼最多保留的历史快照数
_fish_lock = threading.Lock()

# 最近的背包鱼价格快照（含各价档）
FISH_SNAPSHOT = {}           # fishId -> {name, sellPrice, quantity, sellLevels, buyLevels, ...}
_snap_lock = threading.Lock()


def record_order_book(fish_id, sell_levels, ts=None):
    """记录一条鱼的盘口快照（供走势线）。sell_levels: [{unitPrice, quantity}]"""
    if not fish_id or not sell_levels:
        return
    ts = ts or int(time.time() * 1000)
    levels = {int(s.get('unitPrice', 0)): int(s.get('quantity', 0)) for s in sell_levels if s.get('unitPrice')}
    with _fish_lock:
        hist = FISH_PRICE_HISTORY.setdefault(fish_id, [])
        hist.append((ts, levels))
        if len(hist) > FISH_PRICE_HISTORY_MAX:
            del hist[:len(hist) - FISH_PRICE_HISTORY_MAX]


def price_history(fish_id, n=30):
    """返回某条鱼的价格历史（最新在前）。"""
    with _fish_lock:
        hist = FISH_PRICE_HISTORY.get(fish_id, [])
        return hist[-n:][::-1] if hist else []


def all_price_history(n=30):
    with _fish_lock:
        return {fid: hist[-n:][::-1] for fid, hist in FISH_PRICE_HISTORY.items()}


def set_fish_snapshot(fish_id, data):
    with _snap_lock:
        FISH_SNAPSHOT[fish_id] = data


def get_fish_snapshots():
    with _snap_lock:
        return dict(FISH_SNAPSHOT)


def scan_backpack_fish(api_runner=None):
    """扫描背包鱼 + 拉 order-book，生成价格快照 JSON。
    api_runner: 可调用 fn(args...) 返回 JSON；默认用 subprocess 调 api.py。"""
    if api_runner is None:
        import subprocess
        def runner(*args):
            r = subprocess.run(['python3', os.path.join(os.path.dirname(__file__), 'api.py')] + list(args),
                               capture_output=True, text=True, timeout=90)
            out = r.stdout
            idx = out.find('{')
            try:
                return json.loads(out[idx:])
            except Exception:
                return {}
        api_runner = runner

    # 1. 背包鱼
    inv = api_runner('raw', '/api/inventory/fish')
    fish = inv.get('data', inv).get('fish', []) if isinstance(inv, dict) else []
    if not fish:
        return {'error': 'no backpack fish', 'fish': []}

    # 2. market overview (latest trade + 24h change)
    overview = {}
    try:
        ov = api_runner('raw', '/api/market/fish/overview')
        for f in (ov.get('data', ov).get('fish', []) if isinstance(ov, dict) else []):
            overview[f.get('fishId')] = f
    except Exception:
        pass

    result = []
    for f in fish:
        fid = f.get('fishId')
        if not fid:
            continue
        entry = {
            'fishId': fid,
            'name': f.get('name'),
            'rarity': f.get('rarity'),
            'quantity': f.get('quantity'),
            'totalCaught': f.get('totalCaught'),
            'sellPrice': f.get('sellPrice'),  # NPC回收价
            'titanValue': f.get('titanValueSummary'),
            'sellLevels': [],   # 市场卖价档
            'buyLevels': [],    # 市场买价档
            'latestTradeUnitPrice': None,
            'priceChange24hBp': None,
        }
        ov = overview.get(fid, {})
        entry['latestTradeUnitPrice'] = ov.get('latestTradeUnitPrice')
        entry['priceChange24hBp'] = ov.get('priceChange24hBasisPoints')
        # 拉 order-book
        try:
            ob = api_runner('raw', f'/api/market/fish/{fid}/order-book')
            d = ob.get('data', ob)
            if isinstance(d, dict):
                entry['sellLevels'] = d.get('sellLevels', []) or []
                entry['buyLevels'] = d.get('buyLevels', []) or []
                record_order_book(fid, entry['sellLevels'])
        except Exception:
            pass
        set_fish_snapshot(fid, entry)
        result.append(entry)

    return {'fish': result, 'count': len(result), 'ts': int(time.time() * 1000)}


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--save', help='写快照 JSON 到文件')
    ap.add_argument('--json', action='store_true', help='stdout 输出完整 JSON')
    args = ap.parse_args()
    data = scan_backpack_fish()
    if args.save:
        with open(args.save, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        print('saved', len(data.get('fish', [])), 'fish ->', args.save)
    else:
        print(json.dumps(data, ensure_ascii=False, indent=1))
