#!/usr/bin/env python3
"""fish_economy.py —— Reelax 钓鱼收益模型与加点分析 🍊

公式全部逆向自线上前端 bundle（static.reelax.cn/assets/index-*.js，2026-08-12 抓取），
并用玩家 4 小时实测会话校准（预测 9361 条 vs 实测 9421 条，总鱼数误差 0.6%）。
纯标准库、零网络请求，离线可跑。

三组核心关系（也是本工具的计算内核）：
  1. 力量 → 单杆最大鱼数量：ly(rarity, strength) = 1 + #{阈值 <= strength}
     阈值见下方 STRENGTH_TAU；传说及以上恒为 1 条。
  2. 智力 → 经验/金币：经验 +0.01%/点（basis points = min(int, 50000)，封顶 +500%），
     与天气/专精/天赋/公会/组队乘算；每 150 点智力使每杆「金币上限」+5。
     耐力每 150 点使「金币下限」+5，另每 1 点耐力 = 每批 +2 杆（totalCasts = 2×endurance）。
  3. 运气 → 9 稀有度分布：weight = baseWeight × (1 + 有效运气/100 × 敏感度) × 饵倍率 × 天气倍率
     有效运气 = (属性+装备+公会+勋章) × (1+运气增益%) + 鱼饵运气。
     运气 ≥ 15000 后公会图腾给神话/奇异/奥秘额外敏感度（见 PT）。

用法：
  python3 api/fish_economy.py thresholds                  # 力量→单杆上限表
  python3 api/fish_economy.py dist                        # 当前属性下的 9 鱼分布
  python3 api/fish_economy.py dist --luck 5000 --bait medium --weather clear
  python3 api/fish_economy.py cast                        # 单杆期望收益分解
  python3 api/fish_economy.py cast --margin market        # 传奇+ 按市场价估算
  python3 api/fish_economy.py alloc                       # 加点方案对比 + 边际价值
  python3 api/fish_economy.py alloc --bait medium --margin market
  python3 api/fish_economy.py sweep                       # 运气/力量扫描找最优分配

说明：
  - 默认属性 = 玩家 valetzx（Lv2225）当前状态：总 力6291 智1591 运9909 耐158，
    其中基础加点 力400 智0 运4048 耐100，固定贡献（杆/装备/勋章/奖杯/公会）为其余部分。
  - 默认运气增益 2500bp（遗物商店「星鳞灵感 II」+25%）；buff 过期后传 --buff-bp 0。
  - 默认顶级饵 + 奥秘涌流天气（2026-08-12 当时的线上状态）。
  - 保底（pity）由服务端 /api/statistics 下发，本工具不含保底；当前玩家曾 21271 杆
    未出奥秘（软保底 21163、硬保底 32826），这类信息看扩展「保底监控」。
"""

import argparse
import math

RARITIES = ['common', 'uncommon', 'fine', 'rare', 'epic', 'legendary', 'mythic', 'exotic', 'arcane']
RARITY_CN = {
    'common': '普通', 'uncommon': '罕见', 'fine': '精良', 'rare': '稀有', 'epic': '史诗',
    'legendary': '传说', 'mythic': '神话', 'exotic': '奇异', 'arcane': '奥秘',
}

# 9 稀有度基础参数（逆向自 bundle ho[]）
BASE_WEIGHT = {
    'common': 550_000_000, 'uncommon': 280_000_000, 'fine': 120_000_000, 'rare': 40_000_000,
    'epic': 9_881_800, 'legendary': 100_000, 'mythic': 16_000, 'exotic': 2_000, 'arcane': 200,
}
LUCK_SENS = {
    'common': 0.0, 'uncommon': 0.02, 'fine': 0.05, 'rare': 0.1, 'epic': 0.25,
    'legendary': 1.7, 'mythic': 1.7, 'exotic': 1.5, 'arcane': 2.0,
}
XP_MULT = {
    'common': 1.05, 'uncommon': 1.15, 'fine': 1.3, 'rare': 1.5, 'epic': 1.8,
    'legendary': 2.2, 'mythic': 2.8, 'exotic': 3.6, 'arcane': 5.0,
}
FISH_BASE = {
    'common': 25, 'uncommon': 60, 'fine': 150, 'rare': 400, 'epic': 1000,
    'legendary': 5000, 'mythic': 70_000, 'exotic': 200_000, 'arcane': 1_000_000,
}
FISH_STEP = {
    'common': 3, 'uncommon': 5, 'fine': 15, 'rare': 50, 'epic': 200,
    'legendary': 1500, 'mythic': 5000, 'exotic': 20_000, 'arcane': 100_000,
}
FISH_COUNT = {'common': 12, 'uncommon': 10, 'fine': 8, 'rare': 8, 'epic': 8,
              'legendary': 5, 'mythic': 5, 'exotic': 5, 'arcane': 5}

# 力量 → 单杆最多条数阈值（ly = 1 + 阈值个数 ≤ strength）
STRENGTH_TAU = {
    'common':   [25, 100, 200, 350, 550, 800, 1100, 1400, 1700, 2200, 2800, 3500, 4500, 6000, 8000, 11000, 15000, 20000, 27000, 36000, 48000],
    'uncommon': [50, 200, 400, 650, 900, 1250, 1700, 2300, 3000, 4000, 5500, 7500, 10000, 14000, 19000, 26000, 35000, 47000],
    'fine':     [300, 600, 900, 1300, 1700, 2300, 3100, 4200, 5700, 7800, 10500, 14000, 19000, 26000, 35000, 47000],
    'rare':     [600, 1100, 1700, 2400, 3300, 4500, 6200, 8500, 11500, 15500, 21000, 28000, 38000, 50000],
    'epic':     [900, 1700, 2600, 3800, 5400, 7600, 10500, 14500, 20000, 27500, 38000, 50000],
    'legendary': [], 'mythic': [], 'exotic': [], 'arcane': [],
}

# 公会图腾运气加成（有效运气 ≥ startsAt 起，每 step 运气 +bonusPerStep 敏感度）
PT = {'startsAt': 15000, 'capsAt': 50000, 'step': 5000,
      'bonusPerStep': {'mythic': 0.05, 'exotic': 0.1, 'arcane': 0.25}}

# 类别权重（鱼/遗物/装备/宝箱）
CAT_WEIGHT = {'fish': 980_000, 'relic': 5_000, 'gear': 10_000, 'chest': 5_000}

# 鱼饵（价格/运气加成/稀有度范围/高阶倍率）
BAITS = {
    'basic':   {'name': '基础饵', 'price': 0,    'luck': 0,    'min': 0, 'max': 1, 'mult': {}},
    'low':     {'name': '低级饵', 'price': 40,   'luck': 0,    'min': 0, 'max': 4, 'mult': {}},
    'medium':  {'name': '中级饵', 'price': 100,  'luck': 250,  'min': 0, 'max': 8, 'mult': {}},
    'high':    {'name': '高级饵', 'price': 200,  'luck': 500,  'min': 0, 'max': 8,
                'mult': {'mythic': 1.25, 'exotic': 1.25, 'arcane': 1.25}},
    'supreme': {'name': '顶级饵', 'price': 1000, 'luck': 1000, 'min': 1, 'max': 8,
                'mult': {'mythic': 1.5, 'exotic': 1.5, 'arcane': 1.5}},
}

# 天气（经验倍率 + 稀有度倍率）
WEATHERS = {
    'clear': {'name': '晴朗', 'xp': 1.0, 'mult': {}},
    'rain': {'name': '雨幕', 'xp': 1.05, 'mult': {'common': 0.97, 'uncommon': 1.1, 'fine': 1.03, 'rare': 1.05, 'epic': 1.1, 'legendary': 1.05, 'mythic': 1.05, 'exotic': 1.03}},
    'gale': {'name': '强风', 'xp': 1.1, 'mult': {'common': 0.95, 'uncommon': 1.05, 'fine': 1.05, 'rare': 1.1, 'epic': 1.1, 'legendary': 1.1, 'mythic': 1.1, 'exotic': 1.05}},
    'mist': {'name': '浓雾', 'xp': 1.2, 'mult': {'common': 0.93, 'fine': 1.1, 'rare': 1.1, 'epic': 1.15, 'legendary': 1.15, 'mythic': 1.15, 'exotic': 1.1, 'arcane': 1.05}},
    'heatwave': {'name': '热浪', 'xp': 1.3, 'mult': {'common': 0.9, 'uncommon': 0.97, 'fine': 1.15, 'rare': 1.1, 'epic': 1.2, 'legendary': 1.2, 'mythic': 1.2, 'exotic': 1.15, 'arcane': 1.1}},
    'tempest': {'name': '雷暴', 'xp': 1.5, 'mult': {'common': 0.9, 'uncommon': 0.95, 'fine': 1.1, 'rare': 1.25, 'epic': 1.25, 'legendary': 1.25, 'mythic': 1.25, 'exotic': 1.25, 'arcane': 1.25}},
    'wither_tide': {'name': '枯潮', 'xp': 0.5, 'mult': {'common': 1.5, 'uncommon': 1.25, 'fine': 0.75, 'rare': 0.75, 'epic': 0.75, 'legendary': 0.75, 'mythic': 0.75, 'exotic': 0.75, 'arcane': 0.75}},
    'gilded_current': {'name': '金风', 'xp': 0.75, 'mult': {'common': 1.25, 'uncommon': 1.25}},
    'arcane_surge': {'name': '奥秘涌流', 'xp': 1.75, 'mult': {'common': 0.85, 'uncommon': 0.92, 'fine': 0.95, 'rare': 1.15, 'epic': 1.4, 'legendary': 1.5, 'mythic': 1.5, 'exotic': 1.75, 'arcane': 3.0}},
}

# 市场买入价/基础价（2026-08-12 实测 order-book 抽样，粗略）
MARKET_MULT = {'common': 1.0, 'uncommon': 1.0, 'fine': 1.0, 'rare': 1.3, 'epic': 1.5,
               'legendary': 1.85, 'mythic': 1.3, 'exotic': 2.3, 'arcane': 6.7}

# 默认玩家状态（valetzx Lv2230，2026-08-12）
DEFAULT_FIXED = {'strength': 5891, 'intelligence': 1591, 'luck': 5860, 'endurance': 58}  # 非加点部分（鱼竿/装备/勋章/奖杯/公会）
DEFAULT_BASE = {'strength': 400, 'intelligence': 0, 'luck': 4058, 'endurance': 100}      # 基础加点
DEFAULT_BIOME_IDX = 4  # b_005 星根洞窟（b_001 起算下标）
DEFAULT_LUCK_BUFF_BP = 2500  # 遗物商店「星鳞灵感 II」+25%


# ---------- 核心公式 ----------

def ly(rarity, strength):
    """单杆最多钓到几条（力量→上限鱼）。"""
    return 1 + sum(1 for t in STRENGTH_TAU[rarity] if strength >= t)


def pt_bonus(luck):
    """运气 ≥15000 后的公会图腾敏感度加成。"""
    p = PT
    u = max(0.0, (min(p['capsAt'], max(p['startsAt'], luck)) - p['startsAt']) / p['step'])
    return {r: v * u for r, v in p['bonusPerStep'].items()}


def rarity_probabilities(eff_luck, bait_id='supreme', weather_id='arcane_surge'):
    """9 稀有度概率。eff_luck 已是最终有效运气（含鱼饵）。"""
    bait = BAITS[bait_id]
    weather = WEATHERS[weather_id]
    allowed = set(RARITIES[bait['min']:bait['max'] + 1])
    bonus = pt_bonus(eff_luck)
    weights = {}
    for r in RARITIES:
        if r not in allowed:
            weights[r] = 0.0
            continue
        bm = bait['mult'].get(r, 1.0)
        wm = weather['mult'].get(r, 1.0)
        m = max(0.0, bm + wm - 1)
        sens = LUCK_SENS[r] + bonus.get(r, 0.0)
        weights[r] = BASE_WEIGHT[r] * (1 + max(0, eff_luck) / 100.0 * sens) * m
    total = sum(weights.values())
    return {r: w / total for r, w in weights.items() if w > 0}


def category_probabilities(bait_id='supreme', weather_id='arcane_surge'):
    """每杆掉落类别（鱼/遗物/装备/宝箱）概率。"""
    bait = BAITS[bait_id]
    weather = WEATHERS[weather_id]
    r = [
        CAT_WEIGHT['fish'],
        CAT_WEIGHT['relic'] * weather.get('relic_mult', 1.0) if bait_id != 'basic' else 0,
        CAT_WEIGHT['gear'] if bait['max'] >= 4 else 0,
        CAT_WEIGHT['chest'] if bait['max'] >= 8 else 0,
    ]
    total = sum(max(0.0, x) for x in r)
    return {c: max(0.0, r[i]) / total for i, c in enumerate(['fish', 'relic', 'gear', 'chest'])}


def fish_avg_value(rarity, biome_idx):
    """该稀有度在指定地图的平均鱼价（基础价，第 o 条 = base + step*o + base*idx*5%）的均值。"""
    return (FISH_BASE[rarity]
            + FISH_STEP[rarity] * (FISH_COUNT[rarity] - 1) / 2
            + math.floor(FISH_BASE[rarity] * biome_idx * 0.05))


def direct_gold_range(intelligence, endurance, biome_gold=(50, 100),
                      gold_min_bonus=0, gold_max_bonus=0, gold_mult_bp=0):
    """每杆直接金币区间 [min, max]（智力提上限、耐力提下限）。"""
    c = math.floor(max(0, intelligence) / 150) * 5
    o = math.floor(max(0, endurance) / 150) * 5
    f = biome_gold[0] + o + gold_min_bonus
    p = max(f, biome_gold[1] + c + gold_max_bonus)
    m = 1 + gold_mult_bp / 10000
    return math.floor(f * m), math.floor(p * m)


def per_cast_ev(eff_luck, strength, intelligence, endurance, biome_idx=DEFAULT_BIOME_IDX,
                bait_id='supreme', weather_id='arcane_surge', margin='base',
                gold_mult_bp=600, gold_min_bonus=0, gold_max_bonus=0, price_fn=None):
    """单杆期望收益分解。返回 dict。

    price_fn: 可选 `price_fn(rarity) -> 价格`，覆盖默认鱼价表（如用背包实际出售价，
    见 history_economy.py 的 --price backpack）；None 时用模型默认价（base/market）。
    """
    mult = MARKET_MULT if margin == 'market' else None
    P = rarity_probabilities(eff_luck, bait_id, weather_id)
    cats = category_probabilities(bait_id, weather_id)
    fish_ev = 0.0
    for r, pr in P.items():
        qty = (1 + ly(r, strength)) / 2  # 数量在 [1, ly] 均匀
        if price_fn is not None:
            val = price_fn(r)
        else:
            val = fish_avg_value(r, biome_idx) * (mult.get(r, 1.0) if mult else 1.0)
        fish_ev += pr * qty * val
    gold_min, gold_max = direct_gold_range(
        intelligence, endurance, gold_min_bonus=gold_min_bonus,
        gold_max_bonus=gold_max_bonus, gold_mult_bp=gold_mult_bp)
    direct = (gold_min + gold_max) / 2.0
    bait_price = BAITS[bait_id]['price']
    return {
        'P': P, 'cats': cats,
        'fish_ev': cats['fish'] * fish_ev,
        'direct_gold': direct,
        'gold_range': (gold_min, gold_max),
        'fish_per_cast': sum(pr * (1 + ly(r, strength)) / 2 for r, pr in P.items()) * cats['fish'],
        'bait_price': bait_price,
        'net': cats['fish'] * fish_ev + direct - bait_price,
    }


# ---------- CLI ----------

def _fmt_pct(v):
    return f'{v * 100:.4f}%'


def cmd_thresholds(args):
    s = args.strength
    print(f'=== 力量 → 单杆最多鱼数量（当前力量 {s}）===')
    print(f'{"稀有度":<8s} {"档位数":>5s} {"满档上限":>7s} {"当前上限":>7s} {"下一档力量":>10s}')
    for r in RARITIES:
        t = STRENGTH_TAU[r]
        nxt = next((x for x in t if x > s), None)
        print(f'{RARITY_CN[r]:<8s} {len(t):>5d} {1 + len(t):>7d} {ly(r, s):>7d} {str(nxt) if nxt else "—":>10s}')


def cmd_dist(args):
    luck = args.luck if args.luck is not None else DEFAULT_FIXED['luck'] + DEFAULT_BASE['luck']
    eff = (luck * (1 + args.buff_bp / 10000)) + BAITS[args.bait]['luck']
    P = rarity_probabilities(eff, args.bait, args.weather)
    print(f'=== 9 鱼分布 ===')
    print(f'有效运气 {eff:.0f}（基础/总运气 {luck} × 增益{args.buff_bp}bp + 饵 {BAITS[args.bait]["luck"]}）| 饵 {BAITS[args.bait]["name"]} | 天气 {WEATHERS[args.weather]["name"]}')
    for r in RARITIES:
        if r in P:
            print(f'  {RARITY_CN[r]:<4s} {_fmt_pct(P[r])}')


def cmd_cast(args):
    eff = _eff_luck(args)
    s = args.strength
    r = per_cast_ev(eff, s, args.intelligence, args.endurance,
                    bait_id=args.bait, weather_id=args.weather, margin=args.margin)
    print(f'=== 单杆期望收益（{BAITS[args.bait]["name"]} · {WEATHERS[args.weather]["name"]} · 市场价:{args.margin}）===')
    print(f'有效运气 {eff:.0f} | 力量 {s} 智 {args.intelligence} 耐 {args.endurance}')
    print(f'每杆鱼数量: {r["fish_per_cast"]:.2f} 条')
    print(f'类别概率: 鱼 {_fmt_pct(r["cats"]["fish"])} 遗物 {_fmt_pct(r["cats"]["relic"])} 装备 {_fmt_pct(r["cats"]["gear"])} 宝箱 {_fmt_pct(r["cats"]["chest"])}')
    print(f'鱼收益: {r["fish_ev"]:.0f} 金')
    print(f'直接金币: {r["direct_gold"]:.0f} 金（区间 {r["gold_range"][0]}-{r["gold_range"][1]}）')
    print(f'饵价: -{r["bait_price"]} 金')
    print(f'--- 净收益: {r["net"]:.0f} 金/杆')
    print('\n稀有度分布:')
    for k, v in sorted(r['P'].items(), key=lambda x: -x[1]):
        print(f'  {RARITY_CN[k]:<4s} {_fmt_pct(v)}')


def cmd_guide(args):
    """加点收益表：力量档位 / 运气边际 / 按总基础点的分配建议。"""
    fixed = _fixed(args)
    cur = {'strength': args.base_str, 'intelligence': args.base_int,
           'luck': args.base_luck, 'endurance': args.base_end}
    bait = args.bait
    weather = args.weather
    buff = args.buff_bp

    def total(base):
        return {k: fixed[k] + base[k] for k in base}

    def net_of(strength, luck_total):
        """固定智/耐，给定总力量与总运气，返回净/杆。"""
        s = {'strength': strength, 'intelligence': total(cur)['intelligence'],
             'endurance': total(cur)['endurance']}
        eff = (luck_total * (1 + buff / 10000)) + BAITS[bait]['luck']
        return per_cast_ev(eff, s['strength'], s['intelligence'], s['endurance'],
                           bait_id=bait, weather_id=weather, margin=args.margin)['net']

    cur_total = total(cur)
    cur_str = cur_total['strength']
    cur_luck = cur_total['luck']
    cur_int = cur_total['intelligence']
    cur_end = cur_total['endurance']
    eff_luck = (cur_luck * (1 + buff / 10000)) + BAITS[bait]['luck']
    print(f'=== 加点收益表（{BAITS[bait]["name"]} · {WEATHERS[weather]["name"]} · 市场价:{args.margin} · 运气增益 {buff}bp）===')
    print(f'当前总属性: 力 {cur_str} 智 {cur_int} 运 {cur_luck}（有效 {eff_luck:.0f}） 耐 {cur_end}\n')

    def net_of(strength, luck_total):
        """固定智/耐，给定总力量与总运气，返回净/杆。"""
        eff = (luck_total * (1 + buff / 10000)) + BAITS[bait]['luck']
        return per_cast_ev(eff, strength, cur_int, cur_end,
                           bait_id=bait, weather_id=weather, margin=args.margin)['net']

    # 1. 力量档位表：从当前力量出发，展示跨过每个阈值的收益（运气保持当前）
    print(f'—— 力量档位表（运气保持当前 {cur_luck}，总力量从 {cur_str} 起）——')
    print(f'{"目标总力量":>9s} {"还差":>6s} {"累计净增":>8s} {"本档净增":>8s} {"累计(金/点)":>10s}')
    n_orig = net_of(cur_str, cur_luck)
    prev_t = cur_str
    n_prev = n_orig
    skipped = 0
    thresholds = sorted({t for r in RARITIES for t in STRENGTH_TAU[r] if t > cur_str})
    for t in thresholds:
        n_t = net_of(t, cur_luck)
        cum = n_t - n_orig
        jump = n_t - n_prev
        if abs(jump) < 0.5:
            skipped += 1
            prev_t = t
            n_prev = n_t
            continue
        print(f'{t:>9d} {t - cur_str:>6d} {cum:>+8.1f} {jump:>+8.1f} {(cum / (t - cur_str)):>10.3f}')
        prev_t = t
        n_prev = n_t
    if skipped:
        print(f'  （另有 {skipped} 档无收益已省略，如普通档 8000 在当前饵下不产鱼）')

    # 2. 运气边际表：每档总运气间隔的净增量（力量保持当前）
    print(f'\n—— 运气边际表（力量保持当前 {cur_str}）——')
    print(f'{"总运气":>7s} {"有效运气":>8s} {"P(传说+)":>9s} {"较上一档(金/杆)":>12s}')
    luck_points = sorted(set([4000, 6000, 8000, cur_luck, 14000, 16000, 20000, 25000, 30000]))
    for i, luck in enumerate(luck_points):
        luck = max(0, min(50000, int(luck)))
        eff = (luck * (1 + buff / 10000)) + BAITS[bait]['luck']
        r = per_cast_ev(eff, cur_str, cur_int, cur_end, bait_id=bait, weather_id=weather, margin=args.margin)
        pe = sum(v for k, v in r['P'].items() if k in ('legendary', 'mythic', 'exotic', 'arcane')) * 100
        tag = ' ← 当前' if luck == int(cur_luck) else ''
        if i == 0:
            inc = '—'
        else:
            prev_luck = max(0, min(50000, int(luck_points[i - 1])))
            eff_prev = (prev_luck * (1 + buff / 10000)) + BAITS[bait]['luck']
            n_prev = per_cast_ev(eff_prev, cur_str, cur_int, cur_end, bait_id=bait, weather_id=weather, margin=args.margin)['net']
            inc = f'{r["net"] - n_prev:+.0f}'
        print(f'{luck:>7d} {eff:>8.0f} {pe:>8.2f}% {inc:>12s}{tag}')

    # 3. 按总基础点分档的建议分配（搜索最优力/运）
    print(f'\n—— 按总基础点的推荐分配（粗扫 100 点步长；≈等级按 ~2 点/级反推，仅参考）——')
    print(f'{"总基础点":>8s} {"≈等级":>7s} {"推荐力":>6s} {"推荐运":>6s} {"推荐耐":>6s} {"预期净/杆":>9s}')
    cur_base = sum(cur.values())
    for total_pts in sorted(set([4000, cur_base, 6000, 8000, 10000, 15000])):
        best = None
        best_net = -1e18
        for st in range(0, total_pts + 1, 100):
            for lk in range(0, total_pts - st + 1, 100):
                en = total_pts - st - lk
                b = {'strength': st, 'intelligence': 0, 'luck': lk, 'endurance': en}
                s = total(b)
                eff = (s['luck'] * (1 + buff / 10000)) + BAITS[bait]['luck']
                n = per_cast_ev(eff, s['strength'], s['intelligence'], s['endurance'],
                                bait_id=bait, weather_id=weather, margin=args.margin)['net']
                if n > best_net:
                    best_net = n
                    best = b
        tag = ' ← 当前' if total_pts == cur_base else ''
        approx_lv = round(total_pts / 2.04)
        print(f'{total_pts:>8d} {approx_lv:>7d} {best["strength"]:>6d} {best["luck"]:>6d} {best["endurance"]:>6d} {best_net:>9.0f}{tag}')


def cmd_alloc(args):
    fixed = _fixed(args)
    total_base = sum(DEFAULT_BASE.values()) if args.total_points is None else args.total_points
    cur = {'strength': args.base_str, 'intelligence': args.base_int,
           'luck': args.base_luck, 'endurance': args.base_end}

    def total(base):
        return {k: fixed[k] + base[k] for k in base}

    def net(base):
        s = total(base)
        eff = (s['luck'] * (1 + args.buff_bp / 10000)) + BAITS[args.bait]['luck']
        r = per_cast_ev(eff, s['strength'], s['intelligence'], s['endurance'],
                        bait_id=args.bait, weather_id=args.weather, margin=args.margin)
        return r['net']

    print(f'=== 加点方案对比（总基础点 {total_base} · {BAITS[args.bait]["name"]} · 天气 {WEATHERS[args.weather]["name"]} · 市场价:{args.margin}）===')
    print(f'{"方案":<26s} {"力":>5s} {"智":>4s} {"运":>5s} {"耐":>4s} {"净/杆":>8s}')
    scenarios = {
        '当前 400/0/4048/100': cur,
        '纯运气': {'strength': 0, 'intelligence': 0, 'luck': total_base, 'endurance': 0},
        '运主力 2:1': {'strength': total_base // 3, 'intelligence': 0, 'luck': total_base - total_base // 3, 'endurance': 0},
        '力运均衡 1:1': {'strength': total_base // 2, 'intelligence': 0, 'luck': total_base - total_base // 2, 'endurance': 0},
        '力量主 2:1': {'strength': total_base - total_base // 3, 'intelligence': 0, 'luck': total_base // 3, 'endurance': 0},
        '纯力量': {'strength': total_base, 'intelligence': 0, 'luck': 0, 'endurance': 0},
        '智力流': {'strength': 0, 'intelligence': total_base, 'luck': 0, 'endurance': 0},
    }
    rows = []
    for name, b in scenarios.items():
        n = net(b)
        s = total(b)
        rows.append((name, b, s, n))
    rows.sort(key=lambda x: -x[3])
    for name, b, s, n in rows:
        eff = (s['luck'] * (1 + args.buff_bp / 10000)) + BAITS[args.bait]['luck']
        print(f'{name:<26s} {s["strength"]:>5d} {s["intelligence"]:>4d} {int(eff):>5d} {s["endurance"]:>4d} {n:>8.0f}')

    print('\n=== 边际价值（当前加点 +1000 点单属性）===')
    for attr in ['strength', 'intelligence', 'luck', 'endurance']:
        b1 = dict(cur)
        b1[attr] += 1000
        print(f'  +1000 {attr:12s}: {net(cur):8.0f} -> {net(b1):8.0f}  边际 {net(b1) - net(cur):+.0f}/杆')


def cmd_sweep(args):
    fixed = _fixed(args)
    def net(base, bait):
        s = {k: fixed[k] + base[k] for k in base}
        eff = (s['luck'] * (1 + args.buff_bp / 10000)) + BAITS[bait]['luck']
        r = per_cast_ev(eff, s['strength'], s['intelligence'], s['endurance'],
                        bait_id=bait, weather_id=args.weather, margin=args.margin)
        return r['net']

    total_base = sum(DEFAULT_BASE.values()) if args.total_points is None else args.total_points
    print(f'=== 运气扫描（力量固定 {fixed["strength"] + args.base_str}，{BAITS[args.bait]["name"]}）===')
    print(f'{"基础运气":>8s} {"有效运气":>8s} {"净/杆":>8s}')
    for base_luck in range(0, total_base + 1, 500):
        b = {'strength': args.base_str, 'intelligence': 0, 'luck': base_luck, 'endurance': 0}
        s = {k: fixed[k] + b[k] for k in b}
        eff = (s['luck'] * (1 + args.buff_bp / 10000)) + BAITS[args.bait]['luck']
        print(f'{base_luck:8d} {eff:8.0f} {net(b, args.bait):8.0f}')

    print(f'\n=== 力量扫描（运气 = 剩余点，{BAITS[args.bait]["name"]}）===')
    print(f'{"力量base":>8s} {"总力量":>8s} {"净/杆":>8s}')
    for base_str in range(0, total_base + 1, 500):
        b = {'strength': base_str, 'intelligence': 0, 'luck': total_base - base_str, 'endurance': 0}
        if b['luck'] < 0:
            continue
        s = {k: fixed[k] + b[k] for k in b}
        print(f'{base_str:8d} {s["strength"]:8d} {net(b, args.bait):8.0f}')


# ---------- 参数组装 ----------

def _fixed(args):
    """固定贡献 = 总属性 - 基础加点（默认取玩家当前值）。"""
    return {
        'strength': args.fixed_str, 'intelligence': args.fixed_int,
        'luck': args.fixed_luck, 'endurance': args.fixed_end,
    }


def _eff_luck(args):
    luck = args.luck if args.luck is not None else DEFAULT_FIXED['luck'] + DEFAULT_BASE['luck']
    return (luck * (1 + args.buff_bp / 10000)) + BAITS[args.bait]['luck']


def _add_common(p):
    p.add_argument('--bait', choices=list(BAITS), default='supreme', help='鱼饵（默认顶级饵）')
    p.add_argument('--weather', choices=list(WEATHERS), default='arcane_surge', help='天气（默认奥秘涌流）')
    p.add_argument('--margin', choices=['base', 'market'], default='base',
                   help='鱼价口径：base=基础价(NPC)，market=传奇+按市场买入价（默认 base）')
    p.add_argument('--buff-bp', type=int, default=DEFAULT_LUCK_BUFF_BP,
                   help=f'运气增益 basis points（默认 {DEFAULT_LUCK_BUFF_BP} = 遗物商店+25%）')


def _add_stats(p):
    p.add_argument('--luck', type=int, default=None, help='总/基础运气（缺省用玩家当前值）')
    p.add_argument('--strength', type=int, default=DEFAULT_FIXED['strength'] + DEFAULT_BASE['strength'])
    p.add_argument('--intelligence', type=int, default=DEFAULT_FIXED['intelligence'] + DEFAULT_BASE['intelligence'])
    p.add_argument('--endurance', type=int, default=DEFAULT_FIXED['endurance'] + DEFAULT_BASE['endurance'])


def _add_base(p):
    p.add_argument('--base-str', type=int, default=DEFAULT_BASE['strength'])
    p.add_argument('--base-int', type=int, default=DEFAULT_BASE['intelligence'])
    p.add_argument('--base-luck', type=int, default=DEFAULT_BASE['luck'])
    p.add_argument('--base-end', type=int, default=DEFAULT_BASE['endurance'])
    p.add_argument('--fixed-str', type=int, default=DEFAULT_FIXED['strength'])
    p.add_argument('--fixed-int', type=int, default=DEFAULT_FIXED['intelligence'])
    p.add_argument('--fixed-luck', type=int, default=DEFAULT_FIXED['luck'])
    p.add_argument('--fixed-end', type=int, default=DEFAULT_FIXED['endurance'])
    p.add_argument('--total-points', type=int, default=None, help='总基础点数（缺省 = 默认 4548）')


def main():
    p = argparse.ArgumentParser(description='Reelax 钓鱼收益模型与加点分析（公式逆向自线上 bundle）')
    sub = p.add_subparsers(dest='cmd')

    t = sub.add_parser('thresholds', help='力量 → 单杆最多鱼数量表')
    t.add_argument('--strength', type=int, default=DEFAULT_FIXED['strength'] + DEFAULT_BASE['strength'])

    d = sub.add_parser('dist', help='9 稀有度分布')
    _add_common(d)
    _add_stats(d)

    c = sub.add_parser('cast', help='单杆期望收益分解')
    _add_common(c)
    _add_stats(c)

    a = sub.add_parser('alloc', help='加点方案对比 + 边际价值')
    _add_common(a)
    _add_base(a)

    g = sub.add_parser('guide', help='加点收益表（力量档位 / 运气边际 / 推荐分配）')
    _add_common(g)
    _add_base(g)

    s = sub.add_parser('sweep', help='运气/力量扫描找最优分配')
    _add_common(s)
    _add_base(s)

    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        return
    {'thresholds': cmd_thresholds, 'dist': cmd_dist, 'cast': cmd_cast,
     'alloc': cmd_alloc, 'guide': cmd_guide, 'sweep': cmd_sweep}[args.cmd](args)


if __name__ == '__main__':
    main()
