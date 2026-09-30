#!/usr/bin/env python3
"""shop_gear.py —— 市场扫装备（找能加力量/跨档的装备）🍊

对比当前配装，扫市场在售的高稀有装备，推荐「换上能加多少力、值不值」。
纯只读，不发任何写请求。

用法：
  python3 gaming/shop_gear.py                     # 默认神话/奇异/传说挂单
  python3 gaming/shop_gear.py --rarity mythic     # 只看神话
  python3 gaming/shop_gear.py --min-gain 100      # 只看力量提升 ≥100
  python3 gaming/shop_gear.py --max-price 5000000 # 只看 500 万内
  python3 gaming/shop_gear.py --limit 20          # 显示条数

数据来源：
  /api/me                        当前总属性（力量、金币）
  /api/gear/loadouts             当前配装每槽位装备
  /api/market/orders(gear)       市场在售装备挂单
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'devtools'))

TARGET_STRENGTH = 11500          # 稀有档阈值（从 PLAYBOOK 来）
RARITY_CN = {'legendary': '传说', 'mythic': '神话', 'exotic': '奇异', 'arcane': '奥秘'}


def _data(res):
    return res.get('data', res) if isinstance(res, dict) and 'data' in res else res


def g_stats(g):
    return g.get('effectiveStats') or g.get('stats') or {}


def slot_match(equipped, slot):
    """market 槽位 → 配装里匹配的槽位 key（可能多个，如 ring_1/ring_2）。未装配返回 None。"""
    if slot in equipped:
        return [slot]
    keys = [k for k in equipped if k.startswith(slot + '_')]
    return keys or None


def main():
    p = argparse.ArgumentParser(description='市场扫装备（只读）')
    p.add_argument('--rarity', default='mythic,exotic,legendary', help='稀有度，逗号分隔（默认 神话,奇异,传说）')
    p.add_argument('--limit', type=int, default=15, help='显示条数（默认 15）')
    p.add_argument('--min-gain', type=int, default=30, help='最少力量提升（默认 30）')
    p.add_argument('--max-price', type=int, default=0, help='价格上限（可选）')
    args = p.parse_args()

    from api import ReelaxApi  # noqa: E402
    api = ReelaxApi(timeout=40)

    me = api.me()
    player = me.get('player') or me
    gold = player.get('gold')
    total = (player.get('stats') or {}).get('total') or {}
    str_now = total.get('strength', 0)
    gap = max(0, TARGET_STRENGTH - str_now)

    ld = _data(api.raw('/api/gear/loadouts'))
    los = (ld or {}).get('loadouts') or []
    active = next((lo for lo in los if lo.get('gear')), los[0] if los else {})
    equipped = active.get('gear') or {}

    orders = _data(api.market_orders(
        asset_type='gear', side='sell', rarities=[r for r in args.rarity.split(',') if r],
        stat='strength', limit=100))
    orders = orders.get('orders') or orders if isinstance(orders, dict) else (orders or [])

    rows = []
    for o in orders:
        if o.get('isOwnOrder'):
            continue
        g = ((o.get('asset') or {}).get('gear')) or {}
        if not g:
            continue
        slot = g.get('slot')
        gstr = g_stats(g).get('strength', 0)
        price = o.get('limitUnitPrice') or 0
        keys = slot_match(equipped, slot)
        if keys:
            weak = min(keys, key=lambda k: g_stats(equipped[k]).get('strength', 0))
            cur_str = g_stats(equipped.get(weak) or {}).get('strength', 0)
            dstr = gstr - cur_str
            if dstr <= 0:
                continue
            new_total = str_now + dstr
            tag = '✅跨档!' if new_total >= TARGET_STRENGTH else '升级'
        else:
            dstr = gstr
            cur_str = 0
            new_total = str_now + dstr
            tag = '新槽位'
        rows.append({
            'slot': slot, 'name': g.get('name'), 'rarity': g.get('rarity'),
            'quality': g.get('quality'), 'gstr': gstr, 'cur': cur_str,
            'dstr': dstr, 'price': price, 'tag': tag,
            'new_total': new_total, 'owner': o.get('ownerNickname'),
        })

    if not rows:
        print(f"=== 🛒 扫装备 · 当前力 {str_now:,}（离稀有档 11,500 还差 {gap:,}） ===")
        print('❌ 市场当前没有比配装更高的 {0} 装备（或全低于现有槽位）。'.format(args.rarity))
        print('  还是那句：别花冤枉钱，等开箱。')
        return

    rows.sort(key=lambda x: (-x['dstr'], x['price'] / max(1, x['dstr'])))
    all_rows = [r for r in rows if r['dstr'] >= args.min_gain and (not args.max_price or r['price'] <= args.max_price)]
    display = all_rows[:args.limit]

    print(f"=== 🛒 扫装备 · 当前力 {str_now:,}（离稀有档 11,500 还差 {gap:,}）· 金币 {gold:,} ===")
    print('| 槽位 | 装备 | 稀有 | 品质 | 力 | 当前槽 | +力 | 价格 | 每+力/万 | 建议 |')
    print('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for r in display:
        cost_w = r['price'] / max(1, r['dstr']) / 1e4
        afford = '💰买得起' if r['price'] <= gold else '钱不够'
        print(f"| {r['slot']} | {r['name']} | {RARITY_CN.get(r['rarity'], r['rarity'])} | "
              f"{r['quality']} | {r['gstr']:,} | {r['cur']:,} | +{r['dstr']:,} | "
              f"{r['price'] / 1e4:,.0f}万 | {cost_w:,.0f} | {r['tag']} {afford} |")

    best = display[0] if display else None
    if best:
        print()
        print(f"💡 单件最佳: {best['slot']} {best['name']} +{best['dstr']:,}力 → 总力 {best['new_total']:,}"
              + ('（**跨档成功**）' if best['new_total'] >= TARGET_STRENGTH else f'（还差 {TARGET_STRENGTH - best["new_total"]:,}）'))
        if best['price'] > gold:
            print(f"⚠️ 但价格 {best['price']/1e4:,.0f}万 > 金币 {gold:,}，先攒钱。")

    # 组合：每槽位挑可买且+力最高的，汇总（用全量 all_rows）
    buyable = [r for r in all_rows if r['price'] <= gold]
    by_slot = {}
    for r in buyable:
        if r['slot'] not in by_slot or r['dstr'] > by_slot[r['slot']]['dstr']:
            by_slot[r['slot']] = r
    if by_slot:
        combo_cost = sum(r['price'] for r in by_slot.values())
        combo_gain = sum(r['dstr'] for r in by_slot.values())
        combo_total = str_now + combo_gain
        print(f"🧩 可买组合: {len(by_slot)} 件 ≈ {combo_cost/1e4:,.0f}万 → +{combo_gain:,}力 → 总力 {combo_total:,}"
              + ('（**跨档！**）' if combo_total >= TARGET_STRENGTH else f'（还差 {TARGET_STRENGTH - combo_total:,}，仍跨不了档）'))


if __name__ == '__main__':
    main()
