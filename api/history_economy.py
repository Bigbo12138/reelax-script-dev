#!/usr/bin/env python3
"""history_economy.py —— 用历史「自定义统计」记录做真实收益对比 + 与 fish_economy 模型交叉验证 🍊

背景：
  /api/fishing/custom-statistics/history 返回的每条记录是「一个计时窗口」的渔获汇总：
    harvest = { casts, fishByRarity{9稀有度条数}, gear, chests, relics,
                goldIncome(直接金币), baitCost(饵钱), netGold(= goldIncome - baitCost) }
  注意：goldIncome 只是「每杆直接掉的金币」，**不含鱼的售价**。鱼是另外卖 NPC/市场的，
  所以真实净收益 = 鱼价值(fishByRarity × 价格) + 直接金币 - 饵钱。

价格口径（--price）：
  backpack（默认）: 按「背包实际出售价」——读 api.py inventory-fish 的输出，取各稀有度
                    平均 sellPrice；背包里没有的稀有度（如奇异/奥秘）回退模型 base 价。
  base             : 模型基础价（FISH_BASE/FISH_STEP，NPC 口径）
  market           : 基础价 × 市场倍率（MARKET_MULT）

用法：
  python3 api/history_economy.py                       # 读 /tmp/hist_raw.json，背包价
  python3 api/history_economy.py --file xxx.json
  python3 api/history_economy.py --price base          # 模型基础价口径
  python3 api/history_economy.py --inventory /tmp/inventory_fish.json   # 指定背包数据
  python3 api/history_economy.py --bait-detail         # 逐个窗口列出推断饵/净收益
  python3 api/history_economy.py --weather heatwave    # 模型预测用的天气（默认 arcane_surge）

依赖：同目录 fish_economy.py（公式） + 历史 JSON（由桥拉取，见 SKILL「WS 桥教程」）；
  --price backpack 还需背包 JSON（`python3 devtools/api.py inventory-fish` 输出）。
"""

import argparse
import datetime
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fish_economy import (  # noqa: E402
    RARITIES, RARITY_CN, BAITS, FISH_BASE, FISH_STEP, FISH_COUNT,
    per_cast_ev,
    DEFAULT_FIXED, DEFAULT_BASE, DEFAULT_BIOME_IDX, DEFAULT_LUCK_BUFF_BP,
)

# 饵价 → 推断饵 id（baitCost/casts 落在 ±10% 内）
BAIT_COST_TO_ID = {0: 'basic', 40: 'low', 100: 'medium', 200: 'high', 1000: 'supreme'}


def infer_bait(bait_cost, casts):
    if not casts:
        return 'mixed'
    per = bait_cost / casts
    for cost, bid in BAIT_COST_TO_ID.items():
        if abs(per - cost) <= max(0.1, cost * 0.10):
            return bid
    return 'mixed'  # 非标准单价 = 窗口内换过饵


def model_base_price(rarity, biome_idx):
    """模型基础价（该稀有度在指定地图的平均鱼价）。"""
    return (FISH_BASE[rarity]
            + FISH_STEP[rarity] * (FISH_COUNT[rarity] - 1) / 2
            + math.floor(FISH_BASE[rarity] * biome_idx * 0.05))


def elapsed_hours(it):
    """窗口真实经过时间（endedAt−startedAt，小时）。stopped 窗口的 durationHours
    是计划档期、不是真实时长，必须用时间戳差值；解析失败回退 durationHours。"""
    try:
        t0 = datetime.datetime.fromisoformat(it['startedAt'].replace('Z', '+00:00'))
        t1 = datetime.datetime.fromisoformat(it['endedAt'].replace('Z', '+00:00'))
        h = (t1 - t0).total_seconds() / 3600
        if 0 < h <= 720:
            return h
    except Exception:
        pass
    return it.get('durationHours') or 0


def load_backpack_prices(inventory_path):
    """读背包鱼 JSON（api.py inventory-fish 输出），返回 {稀有度: 平均出售价}。"""
    with open(inventory_path, encoding='utf-8') as f:
        raw = f.read().strip()
    raw = raw[raw.index('{'):]  # 跳过 api.py 的"端口已占用"提示行
    d = json.loads(raw)
    fish = d.get('fish', []) or []
    agg = {}
    for f in fish:
        agg.setdefault(f.get('rarity'), []).append(f.get('sellPrice', 0))
    return {r: sum(ps) / len(ps) for r, ps in agg.items() if ps}


def build_price_fn(price_mode, biome_idx, inventory_path):
    """返回 price_fn(rarity) -> 单价。backpack 缺稀有度（如奇异/奥秘）回退模型 base。"""
    base = lambda r: model_base_price(r, biome_idx)  # noqa: E731
    if price_mode == 'backpack':
        try:
            bp = load_backpack_prices(inventory_path)
        except Exception as e:
            bp = {}
            print(f'⚠️ 读背包价格失败（{inventory_path}）：{e}，回退模型 base 价', file=sys.stderr)
        if not bp:
            print(f'⚠️ 背包 JSON 里没有鱼（{inventory_path}？），回退模型 base 价', file=sys.stderr)
        return lambda r: bp.get(r) if bp.get(r) is not None else base(r)
    if price_mode == 'market':
        from fish_economy import MARKET_MULT
        return lambda r: base(r) * MARKET_MULT.get(r, 1.0)
    return base


def analyze(records, price_fn):
    rows = []
    for it in records:
        h = it.get('harvest') or {}
        casts = h.get('casts') or 0
        if casts <= 0:
            continue
        fb = h.get('fishByRarity') or {}
        bait = infer_bait(h.get('baitCost') or 0, casts)
        fish_value = sum(fb.get(r, 0) * price_fn(r) for r in RARITIES)
        total_income = fish_value + (h.get('goldIncome') or 0)
        net = total_income - (h.get('baitCost') or 0)
        hours = elapsed_hours(it)
        rows.append({
            'startedAt': it.get('startedAt', ''),
            'durationHours': it.get('durationHours'),
            'elapsed_hours': hours,
            'status': it.get('status'),
            'bait': bait,
            'casts': casts,
            'fish': sum(fb.values()),
            'fish_value': fish_value,
            'gold_income': h.get('goldIncome') or 0,
            'bait_cost': h.get('baitCost') or 0,
            'net': net,
            'net_per_cast': net / casts,
            'casts_per_hour': casts / hours if hours > 0 else None,
            'net_per_hour': net / hours if hours > 0 else None,
            'fish_per_cast': sum(fb.values()) / casts,
            'gold_per_cast': (h.get('goldIncome') or 0) / casts,
        })
    return rows


def model_predict(stats, bait, weather, price_fn):
    """模型预测该饵/天气的净/杆（用当前玩家总属性 + 同一价格口径）。"""
    eff = (stats['luck'] * (1 + DEFAULT_LUCK_BUFF_BP / 10000)) + BAITS[bait]['luck']
    r = per_cast_ev(eff, stats['strength'], stats['intelligence'], stats['endurance'],
                    biome_idx=DEFAULT_BIOME_IDX, bait_id=bait, weather_id=weather,
                    margin='base', price_fn=price_fn)
    return r


def main():
    p = argparse.ArgumentParser(description='历史真实收益 vs 模型对比（默认背包出售价）')
    p.add_argument('--file', default='/tmp/hist_raw.json', help='历史 JSON（api.py raw 拉取结果）')
    p.add_argument('--inventory', default='/tmp/inventory_fish.json',
                   help='背包鱼 JSON（api.py inventory-fish 输出）；--price backpack 用')
    p.add_argument('--price', choices=['backpack', 'base', 'market'], default='backpack',
                   help='鱼价口径：backpack=背包实价(默认) / base=模型基础价 / market=市场倍率')
    p.add_argument('--biome-idx', type=int, default=DEFAULT_BIOME_IDX, help='鱼价基准地图下标（默认模型 b_005）')
    p.add_argument('--weather', default='arcane_surge', help='模型预测用天气（默认奥秘涌流）')
    p.add_argument('--bait-detail', action='store_true', help='逐个窗口列出')
    # 模型对比用总属性（默认沿用模型玩家默认值）
    p.add_argument('--strength', type=int, default=DEFAULT_FIXED['strength'] + DEFAULT_BASE['strength'])
    p.add_argument('--intelligence', type=int, default=DEFAULT_FIXED['intelligence'] + DEFAULT_BASE['intelligence'])
    p.add_argument('--luck', type=int, default=DEFAULT_FIXED['luck'] + DEFAULT_BASE['luck'])
    p.add_argument('--endurance', type=int, default=DEFAULT_FIXED['endurance'] + DEFAULT_BASE['endurance'])
    args = p.parse_args()

    with open(args.file, encoding='utf-8') as f:
        raw = f.read().strip()
    raw = raw[raw.index('{'):]  # 跳过 api.py 的"端口已占用"提示行
    d = json.loads(raw)
    records = d['data']['items'] if d.get('data') else d.get('items', [])

    price_fn = build_price_fn(args.price, args.biome_idx, args.inventory)
    rows = analyze(records, price_fn)
    if not rows:
        print('无有效窗口（casts=0 已跳过）')
        return

    print(f'=== 历史真实收益（{len(rows)} 个窗口 · 鱼价口径 {args.price} · 地图下标 {args.biome_idx}）===')
    print(f'真实净收益 = 鱼价值(fishByRarity×价格) + 直接金币 - 饵钱\n')

    if args.bait_detail:
        print(f'{"日期":<15s} {"饵":>7s} {"时长h":>5s} {"杆":>6s} {"净/杆":>7s} {"净/时":>8s} {"净合计":>11s}')
        for r in sorted(rows, key=lambda x: x['startedAt']):
            dte = r['startedAt'][5:16].replace('T', ' ')
            nph = f'{r["net_per_hour"]:,.0f}' if r['net_per_hour'] is not None else '—'
            print(f'{dte:<15s} {r["bait"]:>7s} {r["elapsed_hours"]:>5.1f} {r["casts"]:>6d} '
                  f'{r["net_per_cast"]:>7.0f} {nph:>8s} {r["net"]:>11,.0f}')
        print()

    # 按饵聚合（按真实经过时间归一）
    print('—— 按饵聚合（真实数据 · 按真实经过时间归一）——')
    print(f'{"饵":<9s} {"窗口":>4s} {"总杆":>7s} {"耗时h":>6s} {"净/杆":>7s} {"净/时":>8s} {"净/天":>8s}')
    by_bait = {}
    for r in rows:
        by_bait.setdefault(r['bait'], []).append(r)
    agg = []
    for bait, rs in sorted(by_bait.items()):
        casts = sum(r['casts'] for r in rs)
        hours = sum(r['elapsed_hours'] for r in rs)
        net = sum(r['net'] for r in rs)
        agg.append((bait, {
            'n': len(rs), 'casts': casts, 'hours': hours,
            'net_per_cast': net / casts,
            'net_per_hour': net / hours if hours > 0 else None,
        }))
    for bait, a in sorted(agg, key=lambda x: -(x[1]['net_per_hour'] or -1e18)):
        nph = f'{a["net_per_hour"]:,.0f}' if a['net_per_hour'] is not None else '—'
        print(f'{bait:<9s} {a["n"]:>4d} {a["casts"]:>7,} {a["hours"]:>6.1f} '
              f'{a["net_per_cast"]:>7.0f} {nph:>8s} {(a["net_per_hour"] or 0) * 24:>8,.0f}')

    # 与模型交叉验证（同一价格口径）
    print('\n—— 模型预测（当前属性 力{}/智{}/运{}/耐{} · 天气 {} · 口径 {}）——'.format(
        args.strength, args.intelligence, args.luck, args.endurance,
        args.weather, args.price))
    print(f'{"饵":<10s} {"模型净/杆":>8s} {"实测净/杆":>8s} {"差":>8s}')
    stats = {'strength': args.strength, 'intelligence': args.intelligence,
             'luck': args.luck, 'endurance': args.endurance}
    for bait, a in sorted(agg, key=lambda x: -(x[1]['net_per_hour'] or -1e18)):
        if bait == 'mixed' or bait not in BAITS:
            print(f'{bait:<10s} {"—":>8s} {a["net_per_cast"]:>8.0f} {"—":>8s}')
            continue
        pred = model_predict(stats, bait, args.weather, price_fn)['net']
        act = a['net_per_cast']
        print(f'{bait:<10s} {pred:>8.0f} {act:>8.0f} {act - pred:>+8.0f}')

    # 结论：最优饵（只看单一标准饵的窗口，按净/时）
    known = [x for x in agg if x[0] in BAITS and x[1]['net_per_hour'] is not None]
    if known:
        best = max(known, key=lambda x: x[1]['net_per_hour'])
        print(f'\n📌 历史实测最赚钱饵: {best[0]}（净 {best[1]["net_per_cast"]:+.0f} 金/杆 '
              f'≈ {best[1]["net_per_hour"]:+,.0f} 金/时 ≈ {best[1]["net_per_hour"] * 24:+,.0f} 金/天）')
        print(f'   {best[0]} 窗口 {best[1]["n"]} 个，总 {best[1]["casts"]:,} 杆，耗时 {best[1]["hours"]:.1f}h')


if __name__ == '__main__':
    main()
