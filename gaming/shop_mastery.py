#!/usr/bin/env python3
"""shop_mastery.py —— 专精鱼扫货估价 🍊

给一个地图 id，列出该图专精缺的鱼、市场在售价、补完要多少钱。
纯只读，不发任何写请求。

用法：
  python3 gaming/shop_mastery.py b_009          # 指定地图，输出扫货清单
  python3 gaming/shop_mastery.py --all          # 所有已解锁地图

数据来源：
  /api/mastery                       缺哪些鱼（还差/持有）
  /api/market/fish/overview          每鱼在售量 + 参考成交价
  /api/market/fish/{id}/order-book   每鱼最低卖价（挂单价）
  /api/fishpedia?biomeId=X           每鱼 sellPrice 基础售价（本身市场价）
建议逻辑：市场价 vs 基础价（<1× 捡漏 / <1.5× 便宜 / <3× 正常溢价 / ≥3× 贵），并标出高于/低于近期成交。
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'devtools'))

RARITY_ORDER = ['common', 'uncommon', 'fine', 'rare', 'epic', 'legendary', 'mythic', 'exotic', 'arcane']
RARITY_CN = {'common': '普通', 'uncommon': '罕见', 'fine': '精良', 'rare': '稀有', 'epic': '史诗',
             'legendary': '传说', 'mythic': '神话', 'exotic': '奇异', 'arcane': '奥术'}


def _data(res):
    return res.get('data', res) if isinstance(res, dict) else res


def collect_missing(api, biome):
    """返回缺的鱼列表：{rarity, rarityName, fishId, name, need, hold, buy}。"""
    missing = []
    for r in (biome.get('rarities') or []):
        if not r.get('isFishLocked'):
            continue
        fish = r.get('fish')
        if not fish:
            continue
        rem = r.get('remainingQuantity') or 0
        if rem <= 0:
            continue
        hold = r.get('availableQuantity') or 0
        missing.append({
            'rarity': r['rarity'],
            'rarityName': r.get('rarityName') or RARITY_CN.get(r['rarity'], r['rarity']),
            'fishId': fish['id'],
            'name': fish['name'],
            'need': rem,
            'hold': hold,
            'buy': max(0, rem - hold),
        })
    return missing


def enrich_prices(api, items):
    """补全市场信息：sellQty 在售量、ask 最低卖价、last 参考成交价。"""
    ov = _data(api.market_fish_overview())
    pmap = {f['fishId']: f for f in (ov.get('fish') or [])}
    for it in items:
        o = pmap.get(it['fishId']) or {}
        it['sellQty'] = o.get('sellOrderQuantity') or 0
        it['last'] = o.get('latestTradeUnitPrice')
        it['ask'] = None
    # 对在售的鱼拉 order-book 拿最低挂单（比成交价更准）
    for it in items:
        if it['sellQty'] <= 0:
            continue
        try:
            ob = _data(api.market_order_book(it['fishId']))
            sells = ob.get('sellLevels') or []
            if sells:
                it['ask'] = sells[0]['unitPrice']
                it['sellQty'] = sum(s.get('quantity', 0) for s in sells)
        except Exception:
            pass


def add_base_prices(api, items, biome_id):
    """从 /api/fishpedia 拿每鱼 sellPrice（游戏基础售价=本身市场价）。"""
    try:
        fp = _data(api.raw(f'/api/fishpedia?biomeId={biome_id}'))
        base = {f['fishId']: f.get('sellPrice') for f in (fp.get('fish') or [])}
        for it in items:
            it['base'] = base.get(it['fishId'])
    except Exception:
        for it in items:
            it['base'] = None


def advise(it):
    """根据 ask vs 基础价/近期成交 给买卖建议。"""
    ask, base, last, on_sale = it.get('ask'), it.get('base'), it.get('last'), it['sellQty'] > 0
    if not on_sale:
        return '❌无在售→自钓/悬赏'
    if not ask:
        return '?'
    if base:
        r = ask / base
        if r < 1:
            level = '💎捡漏(<基础价)'
        elif r < 1.5:
            level = '✅便宜'
        elif r < 3:
            level = '正常'
        else:
            level = f'⚠️贵({r:.1f}×)'
    else:
        level = '?'
    if last:
        level += ' 低于近期' if ask < last else (' 高于近期' if ask > last else '')
    return level


def report_one(biome):
    api = None
    from api import ReelaxApi  # noqa: E402
    api = ReelaxApi(timeout=30)
    items = collect_missing(api, biome)
    if not items:
        print(f"✅ {biome.get('biomeName')} ({biome.get('biomeId')}) 没有缺的专精鱼")
        return
    enrich_prices(api, items)
    add_base_prices(api, items, biome.get('biomeId'))
    items.sort(key=lambda x: (RARITY_ORDER.index(x['rarity']) if x['rarity'] in RARITY_ORDER else 99, x['name']))

    bid = biome.get('biomeId')
    print(f"=== 🐟 专精扫货 · {biome.get('biomeName')} ({bid}) ===")
    print('| 稀有度 | 鱼 | 还差 | 需买 | 基础价 | 市场价 | 在售 | 建议 |')
    print('| --- | --- | --- | --- | --- | --- | --- | --- |')
    total = 0
    total_cnt = 0
    no_sale = []
    for it in items:
        base_s = f"{it['base']:,}" if it.get('base') else '?'
        price = it['ask'] or it['last']
        on_sale = it['sellQty'] > 0
        if on_sale and price:
            sub = it['buy'] * price
            total += sub
            total_cnt += it['buy']
            price_s = f"{price:,}"
        elif price:
            price_s = f"参考{price:,}"
        else:
            price_s = '无'
        avail = f"✅{it['sellQty']:,}" if on_sale else '❌'
        if not on_sale:
            no_sale.append(it['name'])
        print(f"| {it['rarityName']} | {it['name']} | {it['need']:,} | {it['buy']:,} | "
              f"{base_s} | {price_s} | {avail} | {advise(it)} |")
    print()
    if total_cnt:
        print(f"💰 可买部分（在售）: {total_cnt:,} 条 ≈ {total / 1e4:,.0f} 万金（按最低挂单）")
    else:
        print('💰 当前没有任何在售的专精鱼，只能自己钓或走悬赏/议价')
    if no_sale:
        print(f"⚠️ 无在售 {len(no_sale)} 种: {'、'.join(no_sale)} → 不计入总额")


def main():
    p = argparse.ArgumentParser(description='专精鱼扫货估价（只读）')
    p.add_argument('biome_id', nargs='?', help='地图 id，如 b_009')
    p.add_argument('--all', action='store_true', help='列出所有已解锁地图')
    args = p.parse_args()

    from api import ReelaxApi  # noqa: E402
    api = ReelaxApi(timeout=30)
    m = _data(api.raw('/api/mastery'))
    biomes = (m or {}).get('biomes') or []
    if not biomes:
        print('❌ 拉不到专精数据（桥离线？）')
        return

    if args.all:
        for b in biomes:
            if not b.get('isUnlocked'):
                continue
            report_one(b)
            print()
        return

    if not args.biome_id:
        print('用法: python3 gaming/shop_mastery.py <地图id> 或 --all')
        print('已解锁地图: ' + '、'.join(f"{b['biomeId']}({b.get('biomeName')})" for b in biomes if b.get('isUnlocked')))
        return

    biome = next((b for b in biomes if b.get('biomeId') == args.biome_id), None)
    if not biome:
        print(f"❌ 没有 {args.biome_id}；已解锁地图: "
              + '、'.join(f"{b['biomeId']}" for b in biomes if b.get('isUnlocked')))
        return
    report_one(biome)


if __name__ == '__main__':
    main()
