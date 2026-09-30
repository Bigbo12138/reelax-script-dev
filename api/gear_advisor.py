#!/usr/bin/env python3
"""gear_advisor.py —— 装备/鱼竿升级建议：换装 + 强化 + 升竿 的最优组合 🍊

回答"现在该升级鱼竿、还是等待/购买装备"这类问题。

思路：
  1. 力量 → 单杆鱼数量是**阶梯函数**（STRENGTH_TAU 阈值）：不跨档时力量投入收益为 0，
     只有跨档才有一次性的鱼数量提升；运气是平滑的、但边际收益很低（实测 ~0.03 金/杆/点）。
  2. 所以最优策略不是"慢慢升鱼竿"（每级 +15 力，跨一档要几十级），而是：
     先用背包里闲置的高属性装备**免费换装**凑近档位，再用**装备强化**（每件几十万，
     一档 +50~100 属性点）补缺口跨档，鱼竿升级作为最后手段。
  3. 收益全部用 fish_economy.per_cast_ev 按玩家真实状态算（鱼价口径默认背包出售价）。

用法（默认在线走桥，见 devtools/api.py）：
  python3 api/gear_advisor.py                            # 在线拉 me/loadouts/gear/rods
  python3 api/gear_advisor.py --bait supreme --weather arcane_surge --buff-bp 0
  python3 api/gear_advisor.py --stat strength            # 换装优先按力量排序
  python3 api/gear_advisor.py --target 11500             # 只看某个力量档
  python3 api/gear_advisor.py --budget 5000000           # 限制预算（金币）

离线模式（桥不可用时用缓存 JSON，跳过 api.py 的"端口已占用"行即可）：
  python3 api/gear_advisor.py --me-file /tmp/me.json --loadouts-file /tmp/loadouts.json \
    --gear-file /tmp/gear.json --rods-file /tmp/rods.json --inventory /tmp/inventory_fish.json

依赖：同目录 fish_economy.py；在线模式还需 ../devtools/api.py（WS 桥）与扩展已连接。
"""

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fish_economy import (  # noqa: E402
    RARITIES, RARITY_CN, BAITS, STRENGTH_TAU, per_cast_ev,
    DEFAULT_BIOME_IDX, DEFAULT_LUCK_BUFF_BP,
)

SLOT_CN = {
    'amulet': '项链', 'boots': '靴子', 'charm': '护符', 'chest': '上衣',
    'gloves': '手套', 'head': '头冠', 'ring_1': '戒指1', 'ring_2': '戒指2',
    'legs': '绑腿', 'weapon': '武器', 'relic': '遗物',
}
ATTR_CN = {'strength': '力量', 'intelligence': '智力', 'luck': '运气', 'endurance': '耐力'}
ATTRS = ['strength', 'intelligence', 'luck', 'endurance']


# ---------- 数据获取 ----------

def _strip_bridge_prefix(raw):
    """跳过 api.py CLI 输出开头的桥状态行（'🔌 端口...'）。"""
    s = raw.strip()
    if not s.startswith('{'):
        idx = s.find('{')
        if idx < 0:
            raise ValueError(f'不是 JSON：{s[:80]}')
        s = s[idx:]
    return json.loads(s)


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return _strip_bridge_prefix(f.read())


def _unwrap_raw(d):
    """raw 响应的包装是 {id,status,ok,data,raw}，取 data；me 等已是裸数据则原样。"""
    if isinstance(d, dict) and 'status' in d and 'data' in d:
        return d['data']
    return d


def fetch_online(timeout):
    """走 WS 桥拉取所有需要的接口。返回 dict（均已解包到 data 层）。"""
    devtools = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'devtools')
    sys.path.insert(0, devtools)
    from api import ReelaxApi  # noqa: E402
    api = ReelaxApi(timeout=timeout)
    return {
        'me': api.me(),
        'loadouts': _unwrap_raw(api.raw('/api/gear/loadouts')),
        'gear': api.inventory_gear(limit=100),
        'rods': _unwrap_raw(api.raw('/api/rods')),
    }


def fetch_offline(args):
    d = {}
    for key, flag in [('me', 'me_file'), ('loadouts', 'loadouts_file'),
                      ('gear', 'gear_file'), ('rods', 'rods_file')]:
        p = getattr(args, flag)
        d[key] = _unwrap_raw(load_json(p)) if p else {}
    return d


# ---------- 属性辅助 ----------

def gear_stats(g):
    return g.get('effectiveStats') or g.get('stats') or {}


def pick(stats, keys):
    return {k: stats.get(k, 0) for k in keys}


def player_from(me):
    p = me.get('player') or me
    return p


def current_total(player):
    return player.get('stats', {}).get('total', {})


def active_loadout(loadouts):
    los = (loadouts or {}).get('loadouts') or []
    for lo in los:
        if lo.get('gear'):
            return lo
    return los[0] if los else {}


def equipped_rod(rods):
    rods_list = (rods or {}).get('rods') or []
    for r in rods_list:
        if r.get('isEquipped'):
            return r
    return rods_list[0] if rods_list else {}


# ---------- 经济模型 ----------

def build_price_fn(price_mode, biome_idx, inventory_path):
    def model_base(r):
        from fish_economy import FISH_BASE, FISH_STEP, FISH_COUNT
        return (FISH_BASE[r]
                + FISH_STEP[r] * (FISH_COUNT[r] - 1) / 2
                + math.floor(FISH_BASE[r] * biome_idx * 0.05))

    if price_mode == 'backpack':
        bp = {}
        try:
            d = load_json(inventory_path)
            fish = d.get('fish', []) or []
            agg = {}
            for f in fish:
                agg.setdefault(f.get('rarity'), []).append(f.get('sellPrice', 0))
            bp = {r: sum(ps) / len(ps) for r, ps in agg.items() if ps}
        except Exception as e:
            print(f'⚠️ 读背包价格失败（{inventory_path}）：{e}，回退模型 base 价', file=sys.stderr)
        return lambda r: bp.get(r) if bp.get(r) is not None else model_base(r)
    if price_mode == 'market':
        from fish_economy import MARKET_MULT
        return lambda r: model_base(r) * MARKET_MULT.get(r, 1.0)
    return model_base


def net_of(stats, price_fn, bait, weather, buff_bp):
    """给定总属性 dict，返回单杆净收益。"""
    eff = (stats.get('luck', 0) * (1 + buff_bp / 10000)) + BAITS[bait]['luck']
    r = per_cast_ev(eff, stats.get('strength', 0), stats.get('intelligence', 0),
                    stats.get('endurance', 0), biome_idx=DEFAULT_BIOME_IDX,
                    bait_id=bait, weather_id=weather, price_fn=price_fn)
    return r


def effective_strength_targets(strength_now, bait, weather, price_fn, buff_bp, stats_base):
    """列出有收益的力量档位（跨档后净/杆增量 > 阈值）。跳过无收益档（如顶级饵下的普通档）。"""
    targets = []
    seen = set()
    for r in RARITIES:
        for t in STRENGTH_TAU[r]:
            if t > strength_now and t not in seen:
                seen.add(t)
    out = []
    for t in sorted(seen):
        s = dict(stats_base)
        s['strength'] = t
        n = net_of(s, price_fn, bait, weather, buff_bp)['net']
        inc = n - net_of(stats_base, price_fn, bait, weather, buff_bp)['net']
        if inc > 0.5:
            out.append((t, inc))
    return out


# ---------- 换装 / 强化 / 升竿 ----------

def swap_candidates(loadout_gear, gear_inv):
    """每个槽位找背包里同槽、力量更高的装备，返回 {slot: [(gear, dstr, dnet_est)]}。"""
    gear_items = gear_inv.get('gear') if isinstance(gear_inv, dict) else (gear_inv or [])
    cands = {}
    for slot, cur in (loadout_gear or {}).items():
        if not cur:
            continue
        cur_s = gear_stats(cur)
        cur_str = cur_s.get('strength', 0)
        pool = []
        for g in gear_items:
            if g.get('slot') != slot:
                continue
            if g.get('id') and g.get('id') == cur.get('id'):
                continue
            gs = gear_stats(g)
            dstr = gs.get('strength', 0) - cur_str
            if dstr > 0:
                pool.append((g, dstr))
        if pool:
            pool.sort(key=lambda x: -x[1])
            cands[slot] = pool
    return cands


def plan_to_target(stats_now, player_gold, loadout_gear, gear_inv, rod,
                   target_str, price_fn, bait, weather, buff_bp, budget=None):
    """找达到 target_str 力量的最小成本方案。

    操作：
      换装（免费，可换多槽）→ 强化（每件装备只算下一级）→ 升竿（+15 力/级）。
    返回 {cost, steps, swaps, upgrade_ids, rod_levels, final_stats, net_inc}。
    """
    budget = budget or (player_gold or float('inf'))
    base_net = net_of(stats_now, price_fn, bait, weather, buff_bp)['net']
    swap_opts = swap_candidates(loadout_gear, gear_inv)
    slot_list = list(swap_opts.keys())

    # 强化能力：每件配装装备 → (cost, str_inc)
    ups = []
    for slot, g in (loadout_gear or {}).items():
        if not g or not g.get('upgradeCost'):
            continue
        nxt = g.get('nextUpgradeStats') or {}
        cur = gear_stats(g)
        dstr = nxt.get('strength', 0) - cur.get('strength', 0)
        if dstr > 0:
            ups.append({'slot': slot, 'cost': g.get('upgradeCost'), 'str': dstr,
                        'name': g.get('name') or slot, 'upgradeLevel': g.get('upgradeLevel', 0)})

    best = None  # {cost, steps, swaps, upgrade_names, rod_levels, final_stats, net_inc}

    def consider(swaps, rod_lv):
        """给定换装组合 + 鱼竿级数，用强化贪心补剩余缺口。"""
        dstr = sum(gear_stats(g).get('strength', 0) - gear_stats(loadout_gear[s]).get('strength', 0)
                   for s, g in swaps)
        dluck = sum(gear_stats(g).get('luck', 0) - gear_stats(loadout_gear[s]).get('luck', 0)
                    for s, g in swaps)
        dint = sum(gear_stats(g).get('intelligence', 0) - gear_stats(loadout_gear[s]).get('intelligence', 0)
                   for s, g in swaps)
        dend = sum(gear_stats(g).get('endurance', 0) - gear_stats(loadout_gear[s]).get('endurance', 0)
                   for s, g in swaps)
        cost = 0
        used_slots = {s for s, _ in swaps}
        # 强化贪心：按 力量增量/成本 排序
        rest = [u for u in ups if u['slot'] not in used_slots]
        rest.sort(key=lambda u: -(u['str'] / u['cost']))
        upgraded = []
        strength = stats_now.get('strength', 0) + dstr + rod_lv * 15
        i = 0
        while strength < target_str and i < len(rest):
            u = rest[i]
            if cost + u['cost'] > budget:
                i += 1
                continue
            cost += u['cost']
            strength += u['str']
            upgraded.append(u)
            i += 1
        if strength < target_str:
            # 还差 → 升竿（每级 +15 力）
            rod_need = (target_str - strength + 14) // 15
            if rod_lv == 0 and rod_need > 0:
                rod_base = rod.get('nextUpgradeCost')
                if not rod_base:
                    return None  # 当前鱼竿无法再升
                rod_total = rod_need * rod_base
                if cost + rod_total <= budget:
                    cost += rod_total
                    rod_lv = rod_need
                    strength = target_str
            if strength < target_str:
                return None
        # 最终属性
        final = dict(stats_now)
        final['strength'] = stats_now.get('strength', 0) + dstr
        final['luck'] = stats_now.get('luck', 0) + dluck
        final['intelligence'] = stats_now.get('intelligence', 0) + dint
        final['endurance'] = stats_now.get('endurance', 0) + dend
        for u in upgraded:
            final['strength'] += u['str']
        # 强化和鱼竿也加运气
        # 简化：强化/鱼竿的 luck 增量按比例忽略（收益主要来自跨力档）
        final['strength'] = target_str if rod_lv > 0 else strength
        final_net = net_of(final, price_fn, bait, weather, buff_bp)['net']
        return {
            'cost': cost,
            'swaps': swaps,
            'upgrades': upgraded,
            'rod_levels': rod_lv,
            'final_stats': final,
            'net_inc': final_net - base_net,
        }

    # 枚举换装组合（每槽：换最优 or 不换）。8 槽 → ≤256 种。
    n = len(slot_list)
    for mask in range(1 << n):
        swaps = []
        for i, slot in enumerate(slot_list):
            if mask & (1 << i):
                swaps.append((slot, swap_opts[slot][0][0]))
        cand = consider(swaps, 0)
        if cand is None:
            continue
        if best is None or (cand['cost'], -cand['net_inc']) < (best['cost'], -best['net_inc']):
            best = cand
    return best


# ---------- 输出 ----------

def fmt_gold(v):
    if v is None:
        return '—'
    if v >= 1e8:
        return f'{v / 1e8:.1f}亿'
    if v >= 1e4:
        return f'{v / 1e4:.1f}万'
    return f'{v:.0f}'


def print_header(player, stats_now, gold, rod):
    lv = player.get('level', '?')
    print(f'=== 装备/鱼竿升级建议 · Lv{lv} ===')
    print(f'金币: {fmt_gold(gold)}   总属性: '
          f'力{stats_now.get("strength",0):,} 智{stats_now.get("intelligence",0):,} '
          f'运{stats_now.get("luck",0):,} 耐{stats_now.get("endurance",0):,}')
    if rod:
        print(f'当前鱼竿: {rod.get("name")} Lv{rod.get("level")} '
              f'（{rod.get("stats", {}).get("strength", 0):,}力/'
              f'{rod.get("stats", {}).get("luck", 0):,}运）下一级 {fmt_gold(rod.get("nextUpgradeCost"))} 金')
    print()


def print_swaps(stats_now, loadout_gear, gear_inv):
    print('—— 背包换装候选（每槽位：比当前配装力量高的）——')
    cands = swap_candidates(loadout_gear, gear_inv)
    if not cands:
        print('  （无，当前配装已是最优）')
        return
    for slot, pool in sorted(cands.items()):
        cur = gear_stats(loadout_gear.get(slot) or {})
        g, dstr = pool[0]
        gs = gear_stats(g)
        print(f'  {SLOT_CN.get(slot, slot):<5s} {loadout_gear[slot].get("name")} → '
              f'{g.get("name")} [{g.get("rarity")}] '
              f'力{cur.get("strength",0):,}→{gs.get("strength",0):,} '
              f'运{cur.get("luck",0):,}→{gs.get("luck",0):,} '
              f'（力+{dstr:,}）')
    print()


def print_plans(stats_now, player_gold, loadout_gear, gear_inv, rod,
                price_fn, bait, weather, buff_bp, budget, target_override):
    print('—— 力量档位与跨档方案（只列最近的 3 档）——')
    targets = effective_strength_targets(
        stats_now.get('strength', 0), bait, weather, price_fn, buff_bp, stats_now)
    if target_override:
        targets = [(target_override, None)]
    if not targets:
        print('  （当前饵/属性下无有效力量档可跨）')
        return
    for t, inc_est in targets[:3]:
        plan = plan_to_target(stats_now, player_gold, loadout_gear, gear_inv, rod,
                              t, price_fn, bait, weather, buff_bp, budget)
        inc = inc_est if inc_est is not None else (plan['net_inc'] if plan else None)
        gap = t - stats_now.get('strength', 0)
        print(f'  目标档 力量 {t:,}（还差 {gap:,}）')
        if inc is not None:
            print(f'    跨档收益: 净/杆 +{inc:.1f} 金')
        if not plan:
            print(f'    预算 {fmt_gold(budget)} 内无法跨档，建议先换装/攒钱')
            continue
        steps = []
        for s, g in plan['swaps']:
            steps.append(f'换{SLOT_CN.get(s, s)}→{g.get("name")}')
        for u in plan['upgrades']:
            steps.append(f'强化{SLOT_CN.get(u["slot"], u["slot"])}({u["name"]})')
        if plan['rod_levels']:
            steps.append(f'升竿{plan["rod_levels"]}级')
        cost = plan['cost']
        payback_days = cost / (plan['net_inc'] * 7000) if plan['net_inc'] > 0 else None
        print(f'    方案成本: {fmt_gold(cost)}  执行: {" → ".join(steps) if steps else "（无需操作）"}')
        if payback_days:
            print(f'    回本: ≈{payback_days:.1f} 天（按 ~7000 杆/天）')
        print()

    # 鱼竿升级对比
    if rod and rod.get('nextUpgradeCost'):
        base_net = net_of(stats_now, price_fn, bait, weather, buff_bp)['net']
        print('—— 鱼竿升级参考（力量·运气竿 +15力+15运/级）——')
        for lv in (1, 5, 10):
            s = dict(stats_now)
            s['strength'] += 15 * lv
            s['luck'] += 15 * lv
            n = net_of(s, price_fn, bait, weather, buff_bp)['net']
            cost = (rod.get('nextUpgradeCost') or 0) * lv
            print(f'  升{lv}级 {fmt_gold(cost)}: 净/杆 +{n - base_net:.1f} 金'
                  f'（回本 {cost / ((n - base_net) * 7000) if n > base_net else float("inf"):.0f} 天）')
        print()


def main():
    p = argparse.ArgumentParser(description='装备/鱼竿升级建议（换装+强化+升竿最优组合）')
    p.add_argument('--timeout', type=int, default=25, help='桥回传超时（在线模式）')
    p.add_argument('--bait', default='supreme', choices=list(BAITS))
    p.add_argument('--weather', default='arcane_surge')
    p.add_argument('--buff-bp', type=int, default=0,
                   help='运气增益 basis points（默认 0；遗物星鳞灵感 II = 2500）')
    p.add_argument('--price', choices=['backpack', 'base', 'market'], default='backpack')
    p.add_argument('--inventory', default='/tmp/inventory_fish.json', help='背包鱼价 JSON')
    p.add_argument('--budget', type=int, default=None, help='跨档预算上限（默认=当前金币）')
    p.add_argument('--target', type=int, default=None, help='只分析指定力量档')
    # 离线模式
    p.add_argument('--me-file', default=None)
    p.add_argument('--loadouts-file', default=None)
    p.add_argument('--gear-file', default=None)
    p.add_argument('--rods-file', default=None)
    args = p.parse_args()

    if args.me_file or args.loadouts_file or args.gear_file or args.rods_file:
        data = fetch_offline(args)
    else:
        try:
            data = fetch_online(args.timeout)
        except Exception as e:
            print(f'❌ 在线拉取失败：{e}\n'
                  f'   可用离线模式：--me-file --loadouts-file --gear-file --rods-file',
                  file=sys.stderr)
            sys.exit(1)

    me = data.get('me') or {}
    player = player_from(me)
    stats_now = current_total(player)
    gold = player.get('gold')
    lo = active_loadout(data.get('loadouts') or {})
    loadout_gear = lo.get('gear') or {}
    rod = equipped_rod(data.get('rods') or {})
    gear_inv = data.get('gear') or {}

    if not stats_now:
        print('❌ 没拿到玩家状态（me 数据为空）', file=sys.stderr)
        sys.exit(1)

    price_fn = build_price_fn(args.price, DEFAULT_BIOME_IDX, args.inventory)
    budget = args.budget or gold or float('inf')

    print_header(player, stats_now, gold, rod)
    print_swaps(stats_now, loadout_gear, gear_inv)
    print_plans(stats_now, gold, loadout_gear, gear_inv, rod,
                price_fn, args.bait, args.weather, args.buff_bp, budget, args.target)


if __name__ == '__main__':
    main()
