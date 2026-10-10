#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# gaming/daily_report.py —— 挂机日报 / 体检中心（Python 分析模型）
#
# 职责：读扩展 monitor 采集的当日原始数据（data/daily_raw.json）＋玩家状态
#       （data/player.json），结合 api/fish_economy.py 的收益/掉落模型，计算：
#         1. 挂机体检健康分（0-100）
#         2. 今日上杆分析（按图/饵/天气聚合实际产出）
#         3. 运气值掉落概率（rarity_probabilities）
#         4. 欧非指数（实际出货 vs 模型预期）
#         5. 钓鱼玄学日历（今日宜钓图 / 宜钓时段）
#       输出 data/daily_report.json 供 55004 首页展示。
#
# 用法：
#   python3 gaming/daily_report.py --gen            # 读真实数据生成日报 JSON
#   python3 gaming/daily_report.py --gen --demo     # 用演示数据生成（无数据时测试用）
#   python3 gaming/daily_report.py --json           # 直接打印生成后的日报 JSON
#   python3 gaming/daily_report.py --date 20260819  # 指定日期（默认今天）
#
# 依赖：同目录 api/ 下的 fish_economy.py（importable，有 __name__ 守卫）。

import argparse
import json
import math
import os
import sys
from datetime import datetime, timedelta

# 让 api 包可 import：本文件在 gaming/ 下，api 在上级 api/
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_ROOT, os.path.join(_ROOT, 'api'), os.path.join(_ROOT, 'devtools')):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import fish_economy as FE

DATA_DIR = os.path.join(_ROOT, 'data')

# 中文图名（与扩展一致）
BIOME_CN = {
    'b_001': '月落溪谷', 'b_002': '雾语湿地', 'b_003': '镜潮海岸', 'b_004': '雷痕峡湾',
    'b_005': '星根洞窟', 'b_006': '霞栖湖原', 'b_007': '云汐悬湖', 'b_008': '赤砂涌泉',
    'b_009': '极昼冰湾', 'b_010': '沉钟古港', 'b_011': '翡翠洪林', 'b_012': '熔潮环礁',
    'b_013': '天穹鲸海', 'b_014': '时镜回流', 'b_015': '星渊圣海',
}
RARITY_CN = {
    'common': '普通', 'uncommon': '少见', 'fine': '优良', 'rare': '稀有', 'epic': '史诗',
    'legendary': '传说', 'mythic': '神话', 'exotic': '奇异', 'arcane': '奥秘',
}
BAIT_CN = {
    'basic': '基础饵', 'low': '低级饵', 'medium': '中级饵', 'high': '高级饵', 'supreme': '顶级饵',
    'bait_basic': '基础饵', 'bait_low': '低级饵', 'bait_medium': '中级饵',
    'bait_high': '高级饵', 'bait_supreme': '顶级饵',
}
WEATHER_CN = {k: (v['name'] if isinstance(v, dict) else v) for k, v in FE.WEATHERS.items()}


def _norm_bait(bait):
    """把扩展的鱼饵 id（bait_xxx）归一成 fish_economy 的 id（xxx）。"""
    if not bait:
        return 'supreme'
    return bait.replace('bait_', '') if bait in ('bait_basic', 'bait_low', 'bait_medium', 'bait_high', 'bait_supreme') else bait


def _today_str(offset_days=0):
    return (datetime.now() + timedelta(days=offset_days)).strftime('%Y%m%d')


def _load_json(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def _load_raw_data():
    """读取扩展 monitor 写的当日原始数据 + 玩家快照。"""
    candidates = []
    import os as _os
    home = _os.path.expanduser('~')
    for base in (home, ''):
        candidates.append(_os.path.join(base, 'Downloads', 'data', 'daily_raw.json'))
    candidates.append(_os.path.join(DATA_DIR, 'daily_raw.json'))
    for p in candidates:
        d = _load_json(p)
        if d is None:
            continue
        if isinstance(d, dict) and 'raw' in d and isinstance(d.get('raw'), dict):
            return d['raw'], d.get('player') or {}
        if isinstance(d, dict) and ('activeSec' in d or 'totalCasts' in d or 'refillOk' in d):
            return d, {}
    return None, None


def _fetch_live_rarities(timeout=15):
    """通过扩展桥实时拉 /api/statistics，返回 {rarity: fishCaught}（跑慢/桥不可用返回 None）。

    日报出货数本由每日零点基线 statsBaseline 减去“实时累计渔获”得出；但扩展的 daily_raw
    一旦停更（SW 休眠/桥断/浏览器关闭），文件里的 rareCatches 会停留在旧值，漏掉停更后的出货。
    因此在生成日报时，若桥可用，则用它实拉最新累计渔获，覆盖旧文件的差值，保证出货数贴合实际。
    """
    try:
        from api import ReelaxApi  # 复用 devtools/api.py（本文件已把 devtools 加进 sys.path）
        api = ReelaxApi(timeout=timeout)
        stats = api.statistics()
        rarities = (stats or {}).get('rarities') or []
        out = {}
        for r in rarities:
            if r and r.get('rarity') in ('exotic', 'arcane') and isinstance(r.get('fishCaught'), (int, float)):
                out[r['rarity']] = int(r['fishCaught'])
        return out or None
    except Exception as e:
        print('[daily] 实拉 statistics 出货数失败（沿用文件值）:', type(e).__name__, e)
        return None


def _refresh_rare_from_live(raw, date_str, live=None):
    """用实时 /api/statistics 累计渔获 − 当日零点基线，覆盖 raw['rareCatches']。

    仅当 raw 带当天的 statsBaseline 才重算（否则无零点基准，无法换算当日）；失败则保留原值。
    """
    if not isinstance(raw, dict):
        return
    base = raw.get('statsBaseline')
    if not base or base.get('date') != date_str:
        return  # 无当天零点基线，无法换算，保持原样
    if live is None:
        live = _fetch_live_rarities()
    if not live:
        return
    rc = dict(raw.get('rareCatches') or {})
    changed = False
    for key in ('exotic', 'arcane'):
        base_v = base.get(key)
        live_v = live.get(key)
        if base_v is None or live_v is None:
            continue
        new_val = max(0, live_v - base_v)
        if rc.get(key, 0) != new_val:
            rc[key] = new_val
            changed = True
    if changed or (live.get('exotic') is not None or live.get('arcane') is not None):
        raw['rareCatches'] = rc
        print('[daily] 实时出货数已覆盖（基于当日零点基线）→ 奇异 %d · 奥秘 %d'
              % (rc.get('exotic', 0), rc.get('arcane', 0)))


def _save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ---------------- 健康分 ----------------

def compute_health(raw):
    """根据当日原始指标算 0-100 健康分。raw 缺字段时用中性默认，不整体崩。"""
    w = {'online': 0.40, 'refill': 0.20, 'switch': 0.15, 'pity': 0.15, 'offline': 0.10}
    def score(metrics):
        # metrics: {value, target, invert}  invert=True 表示越低越好
        if metrics is None:
            return 1.0
        value = metrics.get('value')
        if value is None:
            return 1.0
        target = metrics.get('target', 1.0)
        invert = metrics.get('invert', False)
        if target <= 0:
            return 1.0
        ratio = value / target
        if invert:
            ratio = max(0.0, 1.0 - ratio)
        return max(0.0, min(1.0, ratio))

    def s_online(raw):
        # 在线率 = 有活动时长 / 期望时长。
        # 期望优先用显式 expectedActiveSec；缺省用「本日累计会话时长（activeSec+offlineSec）」，
        # 即：只要整段挂机都在线就是满分，不再按刚性 24h 全日在场打分。
        # 背景：早上（或任意时段）在线 8h 若按 24h×90%=19.44h 期望算仅得 8/19.44≈41 分被误扣，
        # 实际应看「本次从 startedAt 起都挂着没掉线」。
        active = raw.get('activeSec')
        if active is None:
            return 1.0
        expect = raw.get('expectedActiveSec')
        if expect is None or expect <= 0:
            offline = raw.get('offlineSec', 0)
            elapsed_session = active + offline
            expect = max(float(elapsed_session), 1.0) if elapsed_session > 0 else (24 * 3600 * 0.9)
        return max(0.0, min(1.0, active / expect))

    def s_refill(raw):
        # 补满及时率 = 成功补满次数 / 应补满次数
        ok = raw.get('refillOk', 0)
        need = raw.get('refillNeeded', 0)
        if need <= 0:
            return 1.0
        return max(0.0, min(1.0, ok / need))

    def s_switch(raw):
        # 切图正确率 = 成功切图 / 尝试切图
        ok = raw.get('switchOk', 0)
        try_ = raw.get('switchTry', 0)
        if try_ <= 0:
            return 1.0
        return max(0.0, min(1.0, ok / try_))

    def s_pity(raw):
        # 保底健康度：距硬保底越近越健康（当前杆数/硬保底 → 越接近1越好）；出货即重置，给高分
        pity = raw.get('pity') or {}
        arc = pity.get('arcane') or {}
        exo = pity.get('exotic') or {}
        parts = []
        for p in (arc, exo):
            cur = p.get('currentDry')
            hard = p.get('hardPity')
            if cur is not None and hard:
                parts.append(max(0.0, min(1.0, cur / hard)))
        if not parts:
            return 1.0
        return sum(parts) / len(parts)

    def s_offline(raw):
        # 掉线率惩罚：掉线秒数占挂机时长比例，越低越好
        offline = raw.get('offlineSec', 0)
        active = raw.get('activeSec')
        if not active or active <= 0:
            return 1.0
        return max(0.0, 1.0 - min(1.0, offline / active))

    subscores = {
        'online': round(s_online(raw) * 100),
        'refill': round(s_refill(raw) * 100),
        'switch': round(s_switch(raw) * 100),
        'pity': round(s_pity(raw) * 100),
        'offline': round(s_offline(raw) * 100),
    }
    total = round(
        w['online'] * subscores['online'] +
        w['refill'] * subscores['refill'] +
        w['switch'] * subscores['switch'] +
        w['pity'] * subscores['pity'] +
        w['offline'] * subscores['offline']
    )
    return {'total': total, 'subscores': subscores, 'weights': w}


def health_grade(score):
    if score >= 90:
        return ('S', '挂机状态极佳，几乎零失误')
    if score >= 75:
        return ('A', '状态良好，个别环节可优化')
    if score >= 60:
        return ('B', '基本正常，有可改进项')
    if score >= 40:
        return ('C', '明显异常，建议检查掉线/补杆')
    return ('D', '挂机质量很差，需要排查')


# ---------------- 运气概率 / 欧非 ----------------

def compute_luck_probabilities(player):
    """用玩家当前有效运气 + 默认饵/天气算 9 稀有度掉落概率。"""
    luck = player.get('luck') or 0
    buff_bp = player.get('buffBp') or 0
    bait = _norm_bait(player.get('bait'))
    weather = player.get('weather') or 'clear'
    eff = (luck * (1 + buff_bp / 10000.0)) + FE.BAITS.get(bait, {}).get('luck', 0)
    probs = FE.rarity_probabilities(eff, bait_id=bait, weather_id=weather)
    # 保留中文名 + 百分比
    out = []
    for r in FE.RARITIES:
        p = probs.get(r, 0.0)
        if p > 0:
            out.append({'rarity': r, 'name': RARITY_CN.get(r, r), 'prob': round(p, 4), 'pct': round(p * 100, 3)})
    return {'effLuck': round(eff), 'bait': bait, 'baitName': BAIT_CN.get(bait, bait),
            'weather': weather, 'weatherName': WEATHER_CN.get(weather, weather), 'distribution': out}


def compute_europe_index(raw, player):
    """欧非指数：实际出货数 vs 模型预期出货数。
    expected = 总杆数 * P(奇异+奥秘)。指数>1 欧（出货比预期多），<1 非。"""
    casts = raw.get('totalCasts', 0)
    if casts <= 0:
        return {'index': None, 'note': '暂无足够上杆数据', 'expected': None, 'actual': None}
    luck = player.get('luck') or 0
    buff_bp = player.get('buffBp') or 0
    bait = _norm_bait(player.get('bait'))
    weather = player.get('weather') or 'clear'
    eff = (luck * (1 + buff_bp / 10000.0)) + FE.BAITS.get(bait, {}).get('luck', 0)
    probs = FE.rarity_probabilities(eff, bait_id=bait, weather_id=weather)
    p_rare = probs.get('exotic', 0.0) + probs.get('arcane', 0.0)
    expected = casts * p_rare
    actual = (raw.get('rareCatches', {}) or {}).get('exotic', 0) + (raw.get('rareCatches', {}) or {}).get('arcane', 0)
    idx = round(actual / expected, 3) if expected > 0 else None
    if idx is None:
        note = '数据不足'
    elif idx >= 1.5:
        note = '非常欧！出货远超预期'
    elif idx >= 1.0:
        note = '略欧，出货高于预期'
    elif idx >= 0.5:
        note = '正常偏非，出货低于预期'
    else:
        note = '很非，出货远低于预期'
    return {'index': idx, 'expected': round(expected, 2), 'actual': actual,
            'pRare': round(p_rare * 100, 3), 'note': note}


# ---------------- 玄学日历 ----------------

def compute_zodiac(raw, player, luck_probs):
    """钓鱼玄学日历：结合天气/保底/欧气给「今日宜钓图 + 宜钓时段」。"""
    tips = []
    # 1) 天气 → 宜钓图（雷暴/奥秘涌流对稀有加成大）
    weather = player.get('weather') or 'clear'
    if weather in ('arcane_surge', 'tempest'):
        tips.append({'topic': '天气红利', 'icon': '🌩️',
                     'text': f'当前 {WEATHER_CN.get(weather)}，稀有/奥秘掉落加成大，建议全力驻留当前图。'})
    elif weather == 'gilded_current':
        tips.append({'topic': '金币天气', 'icon': '💰', 'text': '金风天气金币加成，适合刷金币的图。'})
    elif weather == 'wither_tide':
        tips.append({'topic': '枯潮警告', 'icon': '🌑', 'text': '枯潮经验大减，稀有掉落偏低，建议避开或蹭奖。'})
    # 2) 保底进度
    pity = raw.get('pity') or {}
    for key, cn in (('arcane', '奥秘'), ('exotic', '奇异')):
        p = pity.get(key) or {}
        cur = p.get('currentDry'); hard = p.get('hardPity')
        if cur is not None and hard:
            pct = cur / hard
            if pct >= 0.8:
                tips.append({'topic': f'{cn}保底', 'icon': '🎁',
                             'text': f'{cn}保底已到 {round(pct*100)}%，临近硬保底，坚持别换图！'})
            elif pct >= 0.5:
                tips.append({'topic': f'{cn}保底', 'icon': '⏳',
                             'text': f'{cn}保底进度 {round(pct*100)}%，稳中向好。'})
    # 3) 欧气时段（纯玄学，基于玄学日历的"黄道吉时"）
    tips.append({'topic': '宜钓时段', 'icon': '🕒',
                 'text': '玄学吉时（仅供参考）：凌晨 4-6 点、正午 12-13 点。'})
    # 4) 欧非指数
    ei = raw.get('_europeIndex') or {}
    if ei.get('index') is not None and ei['index'] >= 1.0:
        tips.append({'topic': '欧气正旺', 'icon': '🍀',
                     'text': f"当前欧非指数 {ei['index']}，欧气正旺，适合追击稀有出货。"})
    return tips


# ---------------- 今日上杆分析 ----------------

def compute_cast_analysis(raw, player):
    """按图/饵/天气聚合今日实际上杆产出。数据来自 monitor 采集的 casts 明细（可选）。"""
    casts = raw.get('casts') or []
    if not casts:
        return {'totalCasts': raw.get('totalCasts', 0), 'byMap': [], 'byBait': [], 'byWeather': [],
                'note': '暂无逐杆明细（后续版本可采集）'}
    def agg(key):
        groups = {}
        for c in casts:
            k = c.get(key) or 'unknown'
            g = groups.setdefault(k, {'count': 0, 'rare': 0, 'gold': 0})
            g['count'] += 1
            if c.get('rare'): g['rare'] += 1
            g['gold'] += c.get('gold', 0)
        return sorted([{'key': k, 'count': g['count'], 'rare': g['rare'], 'gold': g['gold'],
                        'rareRate': round(g['rare'] / g['count'] * 100, 2) if g['count'] else 0}
                       for k, g in groups.items()], key=lambda x: -x['count'])
    return {'totalCasts': len(casts), 'byMap': agg('map'), 'byBait': agg('bait'), 'byWeather': agg('weather'),
            'note': ''}


# ---------------- 主入口 ----------------

def _demo_raw():
    """无真实数据时生成一份演示数据，便于本地测试/预览页面。"""
    return {
        '_demo': True,
        'activeSec': 20 * 3600,
        'expectedActiveSec': 24 * 3600 * 0.9,
        'offlineSec': 1200,
        'refillOk': 18, 'refillNeeded': 20,
        'switchOk': 34, 'switchTry': 40,
        'totalCasts': 12000,
        'rareCatches': {'exotic': 6, 'arcane': 1},
        'pity': {'arcane': {'currentDry': 28000, 'hardPity': 32826},
                 'exotic': {'currentDry': 6000, 'hardPity': 28000}},
        'casts': [
            {'map': 'b_007', 'bait': 'bait_supreme', 'weather': 'tempest', 'rare': False, 'gold': 120},
            {'map': 'b_007', 'bait': 'bait_supreme', 'weather': 'tempest', 'rare': True, 'gold': 5000},
            {'map': 'b_010', 'bait': 'bait_high', 'weather': 'clear', 'rare': False, 'gold': 90},
            {'map': 'b_007', 'bait': 'bait_supreme', 'weather': 'arcane_surge', 'rare': True, 'gold': 8000},
        ],
    }


def _demo_player():
    return {'luck': 5860, 'buffBp': 0, 'bait': 'bait_supreme', 'weather': 'arcane_surge',
            'strength': 6291, 'intelligence': 1591, 'endurance': 58, 'name': '演示账号'}


def _fmt_hhmm(sec):
    if not sec:
        return '0分'
    m = int(sec // 60); h = m // 60; r = m % 60
    return ('%d时%d分' % (h, r)) if h else ('%d分' % r)


def _build_webhook_text(report, health, europe, raw):
    s = report['summary']
    rare = s.get('rareCatches') or {}
    line = ['[Reelax] 📋 挂机日报 ' + report.get('date', ''),
            '健康分：%d（%s级 · %s）' % (health['total'], report['healthGrade'], report['healthNote']),
            '在线：%s · 掉线：%s' % (_fmt_hhmm(s.get('onlineSec', 0)), _fmt_hhmm(raw.get('offlineSec', 0))),
            '上杆：%d 杆 · 净赚：%s金' % (s.get('totalCasts', 0), _fmt_num(s.get('dailyNetGold', 0))),
            '补满：%d/%d · 切图：%d/%d' % (s.get('refillOk', 0), raw.get('refillNeeded', 0), s.get('switchOk', 0), raw.get('switchTry', 0)),
            '出货：奇异 %d · 奥秘 %d' % (rare.get('exotic', 0), rare.get('arcane', 0)),
        ]
    if europe and europe.get('index') is not None:
        line.append('欧非指数：%s（%s）' % (europe['index'], europe.get('note', '')))
    return '\n'.join(line)


def _fmt_num(v):
    if v is None: return '0'
    try: return '{:,}'.format(int(v))
    except Exception: return str(v)


def gen_report(raw=None, player=None, date_str=None):
    date_str = date_str or _today_str()
    if raw is None and player is None:
        raw, player = _load_raw_data()
    raw = raw or _load_json(os.path.join(DATA_DIR, 'daily_raw.json')) or {}
    player = player or _load_json(os.path.join(DATA_DIR, 'player.json')) or {}

    # 日期归属守卫：生成本日(date_str)日报时，若 daily_raw 的 date 与目标日期不一致
    # （跨天残留 / SW 未推新档 / 签到顺序错配），绝不能把昨天的在线时长/杆数/出货标成今天。
    # 直接改用干净空档（在线 0 等），宁可少报也不报错。
    raw_date = raw.get('date')
    if raw_date is not None and str(raw_date) != str(date_str):
        raw = {
            'date': date_str,
            'startedAt': int(datetime.now().timestamp() * 1000),
            'activeSec': 0, 'offlineSec': 0,
            'refillOk': 0, 'refillNeeded': 0,
            'switchOk': 0, 'switchTry': 0,
            'totalCasts': 0, 'dailyNetGold': 0,
            'rareCatches': {'exotic': 0, 'arcane': 0},
        }

    # 实时校准（出货数）：若扩展 daily_raw 停更（文件 rareCatches 滞后于实际），
    # 用桥实拉的最新 /api/statistics 累计渔获 − 当日零点基线覆盖，贴合真实出货
    # （仅当存在当天 statsBaseline 才可换算；在线时长/上杆等无实时当天源，靠扩展采集）。
    _refresh_rare_from_live(raw, date_str)

    health = compute_health(raw)
    luck_probs = compute_luck_probabilities(player)
    europe = compute_europe_index(raw, player)
    raw['_europeIndex'] = europe
    zodiac = compute_zodiac(raw, player, luck_probs)
    cast_analysis = compute_cast_analysis(raw, player)
    grade, grade_note = health_grade(health['total'])

    report = {
        'date': date_str,
        'generatedAt': datetime.now().isoformat(timespec='seconds'),
        'player': {'name': player.get('name') or '', 'luck': player.get('luck'),
                   'strength': player.get('strength'), 'intelligence': player.get('intelligence')},
        'health': health,
        'healthGrade': grade,
        'healthNote': grade_note,
        'luckProbabilities': luck_probs,
        'europeIndex': europe,
        'zodiac': zodiac,
        'castAnalysis': cast_analysis,
        'summary': {
            'totalCasts': raw.get('totalCasts', 0),
            'onlineSec': raw.get('activeSec', 0),
            'dailyNetGold': raw.get('dailyNetGold', 0),
            'refillOk': raw.get('refillOk', 0),
            'switchOk': raw.get('switchOk', 0),
            'rareCatches': raw.get('rareCatches', {}),
        },
        'dataSource': 'real' if _load_raw_data()[0] else ('demo' if (raw or {}).get('_demo') else 'none'),
        'weeklyAnalysis': compute_weekly_analysis(),
    }
    report['webhookText'] = _build_webhook_text(report, health, europe, raw)
    _save_json(os.path.join(DATA_DIR, 'daily_report.json'), report)
    return report



# ---------------- 周赛分析（第六格） ----------------
# 数据源：/api/weekly-tournaments/overview（current.ranking 前五 + 我）+ 每人 /api/players/{id}/statistics（运气/力量）
# 依赖本机 55004 桥（ws_bridge.request）。桥不可用时返回 None。

def _bridge_get(path, timeout=25):
    try:
        import sys as _s, os as _os
        devtools = _os.path.join(_ROOT, 'devtools')
        if devtools not in _s.path:
            _s.path.insert(0, devtools)
        import ws_bridge
        try:
            ws_bridge.start(port=55004)
        except Exception:
            pass
        r = ws_bridge.request('GET', path, None, timeout=timeout)
        if not r:
            return None
        # r 结构：{status, ok, data, raw}（data 已解析）
        return r.get('data') if r.get('ok') else None
    except Exception:
        return None

def _weekly_rank_cn(r):
    return {'common': '普通', 'uncommon': '少见', 'fine': '优良', 'rare': '稀有', 'epic': '史诗',
            'legendary': '传说', 'mythic': '神话', 'exotic': '奇异', 'arcane': '奥秘'}.get(r, r)

def compute_weekly_analysis(limit=5):
    """拉周赛总览 + 前 N 名玩家属性，生成对比表。返回 dict 或 None。"""
    overview = _bridge_get('/api/weekly-tournaments/overview')
    if not overview or 'current' not in overview:
        return None
    cur = overview.get('current') or {}
    ranking = cur.get('ranking') or []
    me = cur.get('me') or {}
    if not ranking:
        return None
    top = ranking[:limit]
    # 给每人拉玩家统计（运气/力量）
    players = []
    for p in top:
        pid = p.get('publicId')
        st = _bridge_get('/api/players/%s/statistics' % pid) if pid else None
        attrs = {}
        fishing = {}
        if st and st.get('rankings'):
            rk = st['rankings']
            for row in (rk.get('attributes') or []):
                if row.get('category', '').startswith('attribute:'):
                    attrs[row['category'].split(':')[-1]] = row.get('value')
            for row in (rk.get('fishingStatistics') or []):
                fishing[row.get('category')] = row.get('value')
        score = p.get('score') or 0
        fishHit = p.get('fishHitCount') or 0
        rareHits = {'legendary': p.get('legendaryHitCount', 0), 'mythic': p.get('mythicHitCount', 0),
                    'exotic': p.get('exoticHitCount', 0), 'arcane': p.get('arcaneHitCount', 0)}
        rareCount = sum(rareHits.values())
        players.append({
            'rank': p.get('rank'),
            'publicId': pid,
            'nickname': p.get('nickname'),
            'guild': p.get('guildTag') or '',
            'score': score,
            'fishHit': fishHit,
            'totalFish': fishing.get('total_fish_caught'),
            'totalCasts': fishing.get('total_casts'),
            'rareHits': rareHits,
            'rareCount': rareCount,
            'efficiency': round(score / fishHit, 1) if fishHit else 0,  # 分/鱼
            'rareRate': round(rareCount / fishHit * 100, 2) if fishHit else 0,  # 稀有占比%
            'luck': attrs.get('luck'),
            'strength': attrs.get('strength'),
            'isMe': p.get('isMe'),
        })
    # 竞争力分析：给每个玩家按「稀有转化效率」打分（0-100），并分析运气/力量与分数的关系
    analysis = {}
    # 1) 稀有转化率（稀有出货/上鱼）最能体现「运」对分数贡献
    max_rare_rate = max([(pl['rareRate'] or 0) for pl in players], default=0)
    max_eff = max([pl['efficiency'] or 0 for pl in players], default=0)
    for pl in players:
        comp = 0
        comp += 40 * ((pl['rareRate'] or 0) / max_rare_rate if max_rare_rate else 0)  # 稀有转化 40
        comp += 40 * (pl['efficiency'] or 0) / max_eff if max_eff else 0            # 效率 40
        comp += 20 * (min(pl['luck'] or 0, 15000) / 15000.0)                        # 运气 20
        pl['competitiveness'] = round(comp)
    # 2) 相关性洞察：运气/力量与分数的相关（Spearman 风格，简单用秩和判断）
    def rank_list(vals):
        # 返回每个值的秩（降序，缺失值排最后）
        ranked = sorted([(v, i) for i, v in enumerate(vals) if v is not None], reverse=True)
        order = [None] * len(vals)
        for r, (v, i) in enumerate(ranked):
            order[i] = r + 1
        return order
    def corr_rank(x, y):
        # 简单皮尔逊（数据量小够用）
        pts = [(a, b) for a, b in zip(x, y) if a is not None and b is not None]
        n = len(pts)
        if n < 3:
            return None
        mx = sum(a for a, _ in pts) / n; my = sum(b for _, b in pts) / n
        cov = sum((a - mx) * (b - my) for a, b in pts)
        dx = (sum((a - mx) ** 2 for a, _ in pts)) ** 0.5
        dy = (sum((b - my) ** 2 for _, b in pts)) ** 0.5
        return round(cov / (dx * dy), 2) if dx and dy else None
    analysis['luckScoreCorr'] = corr_rank([pl['luck'] for pl in players], [pl['score'] for pl in players])
    analysis['strengthScoreCorr'] = corr_rank([pl['strength'] for pl in players], [pl['score'] for pl in players])
    analysis['rareScoreCorr'] = corr_rank([pl['rareCount'] for pl in players], [pl['score'] for pl in players])
    return {
        'sequence': cur.get('sequence'),
        'groupPublicId': cur.get('groupPublicId'),
        'startAt': cur.get('startAt'),
        'endAt': cur.get('endAt'),
        'myRank': me.get('rank'),
        'myScore': me.get('score'),
        'topPlayers': players,
        'analysis': analysis,
    }


def main():
    ap = argparse.ArgumentParser(description='挂机日报 / 体检中心（生成 daily_report.json）')
    ap.add_argument('--gen', action='store_true', help='生成日报 JSON')
    ap.add_argument('--demo', action='store_true', help='用演示数据生成（无真实数据时测试）')
    ap.add_argument('--json', action='store_true', help='生成后打印 JSON')
    ap.add_argument('--date', default=None, help='日期 YYYYMMDD（默认今天）')
    args = ap.parse_args()

    raw = None
    player = None
    if args.demo:
        raw, player = _demo_raw(), _demo_player()
    report = gen_report(raw=raw, player=player, date_str=args.date)

    if args.json or not args.gen:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"✅ 日报已生成: {os.path.join(DATA_DIR, 'daily_report.json')}")
        print(f"   健康分 {report['health']['total']} ({report['healthGrade']}) · "
              f"欧非指数 {report['europeIndex']['index']} · "
              f"总杆数 {report['summary']['totalCasts']}")


if __name__ == '__main__':
    main()

