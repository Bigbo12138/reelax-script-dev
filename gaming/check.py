#!/usr/bin/env python3
"""check.py —— 一键状态核对 + 决策提示（8 小时例行检查用）🍊

玩家跑这一条命令，把输出发给我，我判断挂机是否正常、要不要动作：
  python3 gaming/check.py                 # 常规（fishing-state + statistics + me）
  python3 gaming/check.py --full          # 完整（再加专精/任务/活动/商店）
  python3 gaming/check.py --diary         # 拉网络日记对比算速率 + 更新 Issue #3「游戏日记」

输出：金币、今日杆数、属性、当前饵、保底进度、决策点提醒。
数据走 WS 桥（devtools/api.py），桥离线会明确提示。
--diary 需要环境变量 CNB_TOKEN（repo-issue 权限）；速率 = 与上次网络日记对比；
拉取只读，PATCH 更新有 30 分钟门槛（距上次更新 <30 分则不写网络）。
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'devtools'))

try:
    from api import ReelaxApi
except ImportError as e:
    print(f'❌ 无法加载桥：{e}')
    sys.exit(1)

# 决策阈值（从 PLAYBOOK 经济事实来）
FORTIFY_TARGET_GOLD = 50_000_000      # 50 箱目标（主线，50×100万）
PITY_WARN_PCT = 90.0                 # 保底进度提醒线

# 游戏日记（CNB Issue #3，仓库 wss/ai/firefoxfish）
DIARY_REPO = 'wss/ai/firefoxfish'
DIARY_ISSUE = 3
DIARY_MIN_INTERVAL_SEC = 30 * 60   # 距上次日记更新 <30 分钟 → 只读不写网络

# 报告输出缓冲：既打印又收集，供 --diary 发布
OUT = []


def say(s=''):
    print(s)
    OUT.append(s)


def diary_get():
    """拉取游戏日记 Issue 正文（上次快照）。无 token / 网络失败返回 None。"""
    token = os.environ.get('CNB_TOKEN')
    if not token:
        return None
    import urllib.request
    import urllib.error
    url = f'https://api.cnb.cool/{DIARY_REPO}/-/issues/{DIARY_ISSUE}'
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.cnb.api+json',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return (json.loads(r.read() or b'{}') or {}).get('body') or ''
    except Exception:
        return None


def diary_parse(text):
    """从上次快照正文解析 (时间, 今日杆数, 金币)。兼容 markdown 表格与旧格式。"""
    if not text:
        return None
    m = re.search(r'一键状态核对 · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})', text)
    if not m:
        return None
    ts = datetime.strptime(m.group(1), '%Y-%m-%d %H:%M:%S')
    gold = casts = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith('|'):
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if len(cells) < 2:
            continue
        label, value = cells[0], cells[1]
        if gold is None and label.startswith('💰 金币'):
            gm = re.search(r'[\d,]+', value)
            if gm:
                gold = int(gm.group().replace(',', ''))
        if casts is None and label.startswith('🐟 今日'):
            cm = re.search(r'([\d,]+)\s*杆|杆\s*([\d,]+)', value)
            if cm:
                casts = int((cm.group(1) or cm.group(2)).replace(',', ''))
    if gold is None or casts is None:
        # 兼容旧格式：今日: ... 杆 N / 金币: N
        mc = re.search(r'今日: \S+  杆 ([\d,]+)', text)
        mg = re.search(r'金币: ([\d,]+)', text)
        if mc and mg:
            gold = int(mg.group(1).replace(',', ''))
            casts = int(mc.group(1).replace(',', ''))
    if gold is None or casts is None:
        return None
    return ts, casts, gold


def diary_rate(prev, casts, gold):
    """对比上次快照算速率文本（表格单元格值）。prev=None → 首次无基准。"""
    if prev is None:
        return '无上次快照可对比（首次写日记）'
    p_ts, p_casts, p_gold = prev
    dt = (datetime.now() - p_ts).total_seconds()
    if dt < 60:
        return '距上次不足 1 分钟，跳过'
    mins = dt / 60
    dc = casts - p_casts
    rate_c = f'{dc / dt * 3600:,.0f} 杆/时' if dc >= 0 else '杆数跨天重置'
    if gold is None or p_gold is None:
        gold_s = '金币无法对比'
    else:
        dg = gold - p_gold
        gold_s = f'金币 {dg:+,}（合 {dg / dt * 3600 / 1e4:+.1f}万/时，含卖鱼/开销）'
    return f'距上次{mins:.0f}分 · {rate_c} · {gold_s}'


def diary_sync(text):
    """把最新快照 PATCH 到游戏日记 Issue 正文（评论接口 403，正文已验证 200）。"""
    token = os.environ.get('CNB_TOKEN')
    if not token:
        say('⚠️ 未设置 CNB_TOKEN，日记未同步（仅终端输出）')
        return False
    import urllib.request
    import urllib.error
    url = f'https://api.cnb.cool/{DIARY_REPO}/-/issues/{DIARY_ISSUE}'
    req = urllib.request.Request(
        url, data=json.dumps({'body': text}).encode(), method='PATCH',
        headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.cnb.api+json',
            'Content-Type': 'application/json',
        })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            say(f'📓 游戏日记已更新（{DIARY_REPO}#{DIARY_ISSUE}，HTTP {r.status}）')
            return True
    except urllib.error.HTTPError as e:
        say(f'⚠️ 日记同步失败 HTTP {e.code}：{e.read()[:200].decode("utf-8", "ignore")}')
        return False
    except Exception as e:
        say(f'⚠️ 日记同步异常：{e}')
        return False


def get(api, fn, *a, **k):
    try:
        return fn(*a, **k)
    except Exception as e:
        print(f'⚠️ {getattr(fn, "__name__", fn)} 拉取失败：{e}')
        return None


def report_decision(gold, pity, run_stats):
    """输出「需要和橘子讨论」的决策点。"""
    say('\n—— 🧭 决策点（触发以下任一，先别动，把本输出发橘子）——')
    hits = []
    if gold is not None:
        if gold >= FORTIFY_TARGET_GOLD:
            hits.append(f'🎯 金币 {gold/1e4:.0f}万 ≥ 5000万 → 讨论「开 50 箱赌奇异」（主线！）')
        elif gold >= 3_000_000:
            gap = FORTIFY_TARGET_GOLD - gold
            hits.append(f'💰 金币 {gold/1e4:.0f}万 / 5000万，还差 {gap/1e4:.0f}万 → 继续攒')
    if pity:
        for r, key, cn in [('奥秘', 'arcane', '奥秘'), ('奇异', 'exotic', '奇异')]:
            d = pity.get(key) or {}
            cur, hard = d.get('currentDryCasts'), d.get('hardPityCasts')
            if cur is not None and hard:
                pct = cur / hard * 100
                if pct >= PITY_WARN_PCT:
                    hits.append(f'🚨 保底·{cn} 进度 {pct:.0f}% → 快出了，保持顶级饵别换！')
                soft = d.get('maxDryCasts')
                if soft and cur >= soft:
                    hits.append(f'⚡ 保底·{cn} 已到软保底（概率满）→ 出货前别换饵/别重置')
                if cur is not None and cur < 100:
                    hits.append(f'🎉 保底·{cn} 刚出货（currentDry 回落至 {cur}）→ 确认出货！卖/留与橘子商量')
    if run_stats:
        s = run_stats
        if s.get('strength', 0) < 11500:
            need = 11500 - s.get('strength', 0)
            hits.append(f'🏋️ 力{s.get("strength",0):,} 离稀有档11,500差{need:,} → 开箱跨档(别强化/别买市场货)')
        elif s.get('strength', 0) < 14000:
            hits.append(f'🏋️ 力{s.get("strength",0):,} 已跨稀有档，下一档14,000还差{14000 - s.get("strength",0)}')
    if hits:
        for h in hits:
            say(f'  {h}')
    else:
        say('  （无触发，按节奏继续挂机）')


def full_report(api):
    """--full：专精 / 任务 / 活动 / 商店 buff 状态。"""
    say('\n—— 📚 专精 / 任务 / 活动 ——')
    mas = get(api, api.raw, '/api/mastery')
    if mas:
        data = mas.get('data', mas) if isinstance(mas, dict) else mas
        biomes = data.get('biomes', []) if isinstance(data, dict) else []
        near = []
        for b in biomes:
            for r in b.get('rarities', []):
                rem = r.get('remainingQuantity')
                if rem is not None and 0 < rem <= 10 and r.get('isFishLocked'):
                    near.append(f"{b['biomeId']} {r['rarity']} 剩{rem}（{r['fish']['name']}）")
        if near:
            say('  专精接近完成档: ' + '；'.join(near))
        else:
            say('  专精: 无 ≤10 条完成的档')
    q = get(api, api.raw, '/api/quests')
    if q:
        data = q.get('data', q) if isinstance(q, dict) else q
        for period in (data.get('periods') or [])[:1]:
            say(f"  每日任务: {period.get('completedCount')}/{period.get('totalCount')} "
                f"（可重掷{period.get('rerollGoldCost')}金）")


def main():
    p = argparse.ArgumentParser(description='一键状态核对 + 决策提示')
    p.add_argument('--full', action='store_true', help='附加专精/任务/活动检查')
    p.add_argument('--diary', action='store_true', help='对比网络日记算速率 + 更新游戏日记 Issue')
    args = p.parse_args()

    api = ReelaxApi(timeout=30)

    fs = get(api, api.fishing_state)
    me = get(api, api.me)
    st = get(api, api.statistics)

    say(f'=== 🍊 一键状态核对 · {time.strftime("%Y-%m-%d %H:%M:%S")} ===')
    if not fs:
        say('❌ 桥拉不到 fishing-state → 挂机可能停了，重启 run.sh')
        return

    run = fs.get('run') or {}
    stats = run.get('stats') or {}
    dh = fs.get('dailyHarvest') or {}

    gold = None
    casts = 0
    level = '?'
    unspent = 0
    if me:
        player = me.get('player') or me
        gold = player.get('gold')
        level = player.get('level')
        unspent = player.get('unspentStatPoints', 0)
    if dh:
        casts = dh.get('casts') or 0

    # ---- 表格行 ----
    rows = []
    status = run.get('status')
    mark = '✅' if status == 'running' else '⚠️'
    if gold is not None:
        pct = gold / FORTIFY_TARGET_GOLD * 100
        rows.append(('💡 速览', f'挂机中{mark} {run.get("biomeId")} · 金币{gold/1e4:.0f}万/5000万({pct:.1f}%)'))
    cycle = run.get('cycleDurationMs') or 0
    cycle_s = f'{cycle / 1000:g}s/杆' if cycle else '?'
    rows.append(('🌊 状态', f'{status} · 本批{run.get("remainingCasts")}/{run.get("totalCasts")} · {cycle_s}'))
    rows.append(('👤 玩家', f'Lv{level} · 力{stats.get("strength",0):,} 运{stats.get("luck",0):,} '
                            f'智{stats.get("intelligence",0):,} 耐{stats.get("endurance",0):,} · 可加点{unspent}'))
    rows.append(('💰 金币', f'{gold:,}' if gold is not None else '?'))
    net = (dh.get('goldIncome') or 0) - (dh.get('baitCost') or 0)
    rows.append(('🐟 今日', f'{dh.get("date")} · {casts:,}杆 · 直金净{net:,}(饵已扣,鱼另计)'))
    rows.append(('🎁 掉落', f'装备{dh.get("gear",0)} · 宝箱{dh.get("chests",0)} · 遗物{dh.get("relics",0)}'))

    pity = None
    if st:
        pity = st.get('pity') or {}
        bits = []
        for r, key, cn in [('奥秘', 'arcane', '奥秘'), ('奇异', 'exotic', '奇异')]:
            d = pity.get(key) or {}
            cur, hard = d.get('currentDryCasts'), d.get('hardPityCasts')
            if cur is not None and hard:
                pct = cur / hard * 100
                soft = d.get('maxDryCasts')
                tag = '⚠️软保底' if soft and cur >= soft else ''
                bits.append(f'{cn}{cur:,}/{hard:,}({pct:.1f}%){tag}')
        if bits:
            rows.append(('🎯 保底', ' · '.join(bits) +
                         f' · 有效运{pity.get("effectiveLuck")} · 饵{pity.get("baitId")}'))

    # ---- 日记：提前拉网络日记算速率 + 30 分钟门控 ----
    diary_note = None
    rate_text = None
    diary_do_sync = False
    if args.diary:
        prev_body = diary_get()
        if prev_body is None:
            diary_note = '拉不到网络日记（无 CNB_TOKEN 或网络失败）'
        else:
            prev = diary_parse(prev_body)
            if prev is None:
                rate_text = diary_rate(None, casts, gold)
                diary_do_sync = True
            else:
                rate_text = diary_rate(prev, casts, gold)
                dt = (datetime.now() - prev[0]).total_seconds()
                if dt < DIARY_MIN_INTERVAL_SEC:
                    diary_note = f'距上次{dt/60:.0f}分 < {DIARY_MIN_INTERVAL_SEC//60}分 → 只读不更新'
                else:
                    diary_do_sync = True
        if rate_text:
            rows.append(('⏱ 速率', rate_text))
        if diary_note:
            rows.append(('📓 日记', diary_note))

    # ---- 打印 markdown 表格 ----
    say('| 项目 | 数值 |')
    say('| --- | --- |')
    for label, value in rows:
        say(f'| {label} | {value} |')

    if args.full:
        full_report(api)

    report_decision(gold, pity, stats)

    if args.diary:
        if diary_do_sync:
            diary_sync('\n'.join(OUT))
    else:
        print('\n→ 把以上输出发橘子即可（尤其决策点部分），别自己动金币/鱼竿/饵；加 --diary 可对比速率并写游戏日记')


if __name__ == '__main__':
    main()
