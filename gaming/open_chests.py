#!/usr/bin/env python3
"""open_chests.py —— 购买/开启奥术宝箱（写操作，必须先确认）🍊

到 5000 万目标时由橘子指挥使用。涉及真实花金币，**每次执行都要玩家点头**。

用法：
  python3 gaming/open_chests.py --status               # 只读：金币 + 宝箱库存
  python3 gaming/open_chests.py --simulate 50          # 假开：本地模拟 50 箱（不发服务器，纯预览）
  python3 gaming/open_chests.py --buy 50 --yes         # 买 50 箱（5000 万，需 --yes）
  python3 gaming/open_chests.py --open 10 --yes        # 开 10 箱（需 --yes）
  python3 gaming/open_chests.py --buy 50 --open --yes  # 买 50 后直接开 50（--open 不带数字=开掉刚买的）

接口（前端 bundle 逆向）：
  POST /api/chests/{chestId}/purchase  body {quantity, paymentCurrency}
  POST /api/chests/{chestId}/open       body {quantity}
写操作带 Idempotency-Key，失败重试安全。
"""

import argparse
import json
import os
import sys
import uuid
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'devtools'))

CHEST_ID = 'arcane_gear_chest'          # 奥术宝箱
CHEST_PRICE = 1_000_000                 # 100 万/个

RARITY_CN = {'common': '普通', 'uncommon': '罕见', 'fine': '精良', 'rare': '稀有', 'epic': '史诗',
             'legendary': '传说', 'mythic': '神话', 'exotic': '奇异', 'arcane': '奥秘'}
RARITY_ORDER = ['arcane', 'exotic', 'mythic', 'legendary', 'epic', 'rare', 'fine', 'uncommon', 'common']

# 奥术宝箱掉率（前端 bundle rarityWeights，权重合计 1000）
RATES = [('fine', 50), ('rare', 350), ('epic', 400), ('legendary', 160),
         ('mythic', 30), ('exotic', 9), ('arcane', 1)]
RARITIES = [r for r, _ in RATES]
WEIGHTS = [w for _, w in RATES]
TOTAL_W = sum(WEIGHTS)
# 市场价中位（万）——只用于模拟估算；奥术无市价不计
AVG_PRICE_W = {'fine': 3, 'rare': 10, 'epic': 50, 'legendary': 100, 'mythic': 600, 'exotic': 5500}


def simulate_open(count):
    """纯本地模拟开箱（蒙特卡洛 + 期望），绝不发服务器。"""
    import random
    print(f'\n🧪 模拟开箱 {count} 箱（纯本地抽卡，不发服务器；结果仅供预览）')
    # 单次抽卡
    draws = random.choices(RARITIES, weights=WEIGHTS, k=count)
    cnt = Counter(draws)
    parts = [f'{RARITY_CN[r]}×{cnt.get(r, 0)}' for r in RARITY_ORDER if cnt.get(r)]
    print('  单次模拟: ' + ('  '.join(parts) if parts else '（全是低级，运气爆炸差）'))
    # 大样本期望
    exp = [f'{RARITY_CN[r]}≈{count * w / TOTAL_W:.1f}' for r, w in RATES if count * w / TOTAL_W >= 0.05]
    print('  大样本期望: ' + '  '.join(exp))
    # 出货概率
    probs = [f'≥1{RARITY_CN[r]} {100 * (1 - (1 - w / TOTAL_W) ** count):.1f}%'
             for r, w in RATES if r in ('mythic', 'exotic', 'arcane')]
    print('  出货概率: ' + '  '.join(probs))
    # 高稀有模拟掉落（随机数值）
    high = [r for r in ('arcane', 'exotic', 'mythic') if cnt.get(r)]
    if high:
        slots = ['ring', 'necklace', 'helmet', 'armor', 'gloves', 'boots', 'weapon', 'trinket', 'belt']
        st_rng = {'mythic': (400, 900), 'exotic': (600, 1300), 'arcane': (1000, 2500)}
        lu_rng = {'mythic': (200, 600), 'exotic': (300, 800), 'arcane': (500, 1500)}
        print('  ⭐ 模拟高稀有（随机数值，非真实掉落）:')
        for r in high:
            for _ in range(cnt[r]):
                s, t = st_rng[r]
                u, v = lu_rng[r]
                g = (f"    {RARITY_CN[r]} · {RARITY_CN[r]}·模拟装备 ({random.choice(slots)}) "
                     f"质{random.randint(85, 100)} 强0 力{random.randint(s, t):,} 运{random.randint(u, v):,}")
                print(g)
    # 价值估算
    ev_w = sum(w / TOTAL_W * AVG_PRICE_W.get(r, 0) for r, w in RATES)
    print(f'  价值估算: 单箱期望 ≈ {ev_w:,.0f}万（不含奥术，无市价）'
          f' → {count}箱 ≈ {ev_w * count:,.0f}万（成本 {count * CHEST_PRICE // 10000:,.0f}万）')


def summarize_open(data):
    """开箱结果总结：数量/稀有度分布/高稀有掉落/资金变化。"""
    gear = (data or {}).get('gear') or []
    qty = (data or {}).get('quantityOpened') or len(gear)
    player = (data or {}).get('player') or {}
    print(f'\n📦 开箱总结: 已开 {qty} 箱 → 获得 {len(gear)} 件装备')
    cnt = Counter(g.get('rarity') for g in gear if isinstance(g, dict))
    if cnt:
        parts = [f'{RARITY_CN.get(r, r)}×{cnt[r]}' for r in RARITY_ORDER if cnt.get(r)]
        print('  稀有度: ' + '  '.join(parts))
    high = [g for g in gear if isinstance(g, dict) and g.get('rarity') in ('legendary', 'mythic', 'exotic', 'arcane')]
    if high:
        print('  ⭐ 高稀有掉落:')
        for g in high:
            st = g.get('effectiveStats') or g.get('baseStats') or {}
            print(f"    {RARITY_CN.get(g.get('rarity'), g.get('rarity'))} · {g.get('name')} "
                  f"({g.get('slot')}) 质{g.get('quality')} 强{g.get('upgradeLevel', 0)} "
                  f"力{st.get('strength', 0):,} 运{st.get('luck', 0):,}")
    if player:
        print(f'  💰 更新后: 金币 {player.get("gold"):,}  遗物 {player.get("relics"):,}')
    else:
        print('  （响应无 player 字段，金币/遗物请再跑 --status 确认）')


def _write(api, path, body):
    """写操作（POST），幂等 key 每次生成。"""
    key = str(uuid.uuid4())
    res = api._post(path, body=body, idempotency_key=key)
    ok = res.get('status') == 200
    return ok, res


def status(api):
    me = api.me()
    p = me.get('player') or me
    gold = p.get('gold')
    chests = api.raw('/api/inventory/chests')
    data = chests.get('data', chests) if isinstance(chests, dict) else chests
    items = (data or {}).get('chests') or []
    arc = next((c for c in items if c.get('chestId') == CHEST_ID), None)
    print(f'金币: {gold:,}')
    if arc:
        print(f'奥术宝箱持有: {arc.get("quantity")} 个（单价 {arc.get("price"):,}）')
    print(f'买 50 箱需: {CHEST_PRICE * 50:,} 金  {"→ 钱够" if gold >= CHEST_PRICE*50 else "→ 钱不够"}')
    return gold


def main():
    p = argparse.ArgumentParser(description='奥术宝箱购买/开启（写操作）')
    p.add_argument('--status', action='store_true', help='只读状态')
    p.add_argument('--buy', type=int, default=0, help='购买数量')
    p.add_argument('--open', nargs='?', type=int, const=-1, default=0,
                   help='开启数量（不带数字=开掉刚买的）')
    p.add_argument('--simulate', nargs='?', type=int, const=50, default=0,
                   help='纯本地模拟开箱 N 箱（默认50，不发服务器）')
    p.add_argument('--yes', action='store_true', help='确认执行（必须）')
    args = p.parse_args()

    from api import ReelaxApi  # noqa: E402

    if args.simulate:
        simulate_open(args.simulate)
        return

    api = ReelaxApi(timeout=40)

    gold = status(api)
    if args.status:
        return

    if args.buy <= 0 and args.open == 0:
        print('⚠️ 没有操作（--buy/--open 至少一个）')
        return

    # --open 不带数字 → 开掉刚买的（等于 --buy 数量）
    open_qty = args.buy if args.open == -1 else args.open
    if open_qty < 0:
        print('❌ --open 数量不能为负')
        return

    cost = args.buy * CHEST_PRICE
    if args.buy > 0:
        print(f'\n【购买 {args.buy} 个奥术宝箱 = {cost:,} 金】')
        if not args.yes:
            print('❌ 未确认（需 --yes）。橘子确认前不要执行。')
            return
        if gold < cost:
            print(f'❌ 金币不足（{gold:,} < {cost:,}），先别买')
            return
        ok, res = _write(api, f'/api/chests/{CHEST_ID}/purchase',
                         {'quantity': args.buy, 'paymentCurrency': 'gold'})
        if not ok:
            print(f'❌ 购买失败: {res.get("status")} {res.get("data") or res.get("error")}')
            return
        print(f'✅ 购买成功: {json.dumps(res.get("data"), ensure_ascii=False)[:400]}')
        if open_qty <= 0:
            return

    if open_qty > 0:
        print(f'\n【开启 {open_qty} 个奥术宝箱】')
        if not args.yes:
            print('❌ 未确认（需 --yes）')
            return
        ok, res = _write(api, f'/api/chests/{CHEST_ID}/open', {'quantity': open_qty})
        if not ok:
            print(f'❌ 开启失败: {res.get("status")} {res.get("data") or res.get("error")}')
            return
        summarize_open(res.get('data') or {})


if __name__ == '__main__':
    main()
