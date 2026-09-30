#!/usr/bin/env python3
# guild_stats.py —— 公会成员四维属性（力量/运气/智力/耐力）分析
#
# 数据来源（走 api.py 的扩展桥，只读）：
#   /api/guilds/{publicId}            公会概况
#   /api/guilds/{publicId}/members    成员列表（cursor 翻页）
#   /api/players/{publicId}/statistics 成员统计，四维在 rankings.attributes
#                                      （category = attribute:strength|luck|intelligence|endurance）
#
# 用法：
#   python3 guild_stats.py 10013
#   python3 guild_stats.py "https://reelax.cn/guilds/10013?view=members"
#   python3 guild_stats.py 10013 --top 5 --sort luck
#   python3 guild_stats.py 10013 --json out.json --csv out.csv
#   python3 guild_stats.py 10013 --stdout-json        # 只吐 JSON，便于管道
#
# 说明：成员数 N 就要发 N+2 个请求，串行 + 节奏控制（默认 0.35s+抖动），
#       避免撞会话频率预算。单个成员失败不影响整体，末尾统一报告。
#
# 依赖：仅标准库 + 同目录 api.py（需 run.sh 已启动 Firefox 且扩展 bridge.js 已加载）。

import argparse
import csv
import json
import os
import random
import re
import sys
import time
import unicodedata
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import ReelaxApi  # noqa: E402

# 四维顺序固定：力量 / 运气 / 智力 / 耐力
ATTRS = [
    ("strength", "力量", "█"),
    ("luck", "运气", "▓"),
    ("intelligence", "智力", "▒"),
    ("endurance", "耐力", "░"),
]
KEYS = [k for k, _n, _c in ATTRS]
CN = {k: n for k, n, _c in ATTRS}
BAR = {k: c for k, _n, c in ATTRS}

ROLE_CN = {"leader": "会长", "co_leader": "副会长", "member": "成员",
           "officer": "官员", "elder": "长老"}


# ---------- 表格渲染（CJK 宽度感知） ----------

def dw(s):
    """显示宽度：东亚全角字符算 2 列。"""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in str(s))


def clip(s, width):
    """按显示宽度截断，超出用 … 收尾。"""
    s = str(s)
    if dw(s) <= width:
        return s
    out, used = "", 0
    for c in s:
        w = 2 if unicodedata.east_asian_width(c) in "WF" else 1
        if used + w > width - 1:
            break
        out += c
        used += w
    return out + "…"


def pad(s, width, align="l"):
    gap = max(0, width - dw(s))
    if align == "r":
        return " " * gap + str(s)
    if align == "c":
        return " " * (gap // 2) + str(s) + " " * (gap - gap // 2)
    return str(s) + " " * gap


def table(headers, rows, aligns=None):
    """渲染一张轻量框线表，返回字符串。"""
    cols = len(headers)
    aligns = aligns or ["l"] * cols
    widths = [dw(h) for h in headers]
    for r in rows:
        for i in range(cols):
            widths[i] = max(widths[i], dw(r[i]))
    line = lambda l, m, r: l + m.join("─" * (w + 2) for w in widths) + r  # noqa: E731
    out = [line("┌", "┬", "┐"),
           "│ " + " │ ".join(pad(headers[i], widths[i], "c") for i in range(cols)) + " │",
           line("├", "┼", "┤")]
    for r in rows:
        out.append("│ " + " │ ".join(pad(r[i], widths[i], aligns[i]) for i in range(cols)) + " │")
    out.append(line("└", "┴", "┘"))
    return "\n".join(out)


def n(v):
    """整数千分位。"""
    try:
        return f"{int(v):,}"
    except (TypeError, ValueError):
        return "-"


def pct(x, digits=1):
    return f"{x * 100:.{digits}f}%"


# ---------- 取数 ----------

def parse_guild_id(s):
    """接受纯数字或含 /guilds/<id> 的 URL。"""
    s = str(s).strip()
    m = re.search(r"/guilds?/(\d+)", s)
    if m:
        return int(m.group(1))
    if re.fullmatch(r"\d+", s):
        return int(s)
    raise ValueError(f"无法从 {s!r} 解析公会 ID（给数字或 https://reelax.cn/guilds/10013 这样的链接）")


class Fetcher:
    """串行取数 + 节奏控制；只读超时重试一次。"""

    def __init__(self, api, delay=0.35, jitter=0.35, quiet=False):
        self.api = api
        self.delay = delay
        self.jitter = jitter
        self.quiet = quiet

    def pace(self):
        time.sleep(self.delay + random.random() * self.jitter)

    def log(self, msg):
        if not self.quiet:
            print(msg, file=sys.stderr, flush=True)

    def get(self, path, retries=1):
        for attempt in range(retries + 1):
            try:
                res = self.api.raw(path)
            except TimeoutError:
                if attempt >= retries:
                    raise
                self.log(f"  ! {path} 桥接超时，重试一次")
                self.pace()
                continue
            if res.get("status") == 200:
                return res.get("data")
            detail = res.get("data") or res.get("error") or (res.get("raw") or "")[:160]
            raise RuntimeError(f"{path} -> {res.get('status')}: {detail}")

    def guild(self, gid):
        return self.get(f"/api/guilds/{gid}")

    def members(self, gid):
        out, cursor = [], None
        while True:
            path = f"/api/guilds/{gid}/members"
            if cursor:
                path += f"?cursor={quote(str(cursor), safe='')}"
            data = self.get(path)
            out.extend(data.get("members") or [])
            cursor = data.get("nextCursor")
            if not cursor:
                return out
            self.pace()

    def player_stats(self, pid):
        return self.get(f"/api/players/{pid}/statistics")


# ---------- 分析 ----------

def classify(shares, ordered):
    """按四维占比给出「流派」标签。

    ordered: [(key, value), ...] 按值降序。
    阈值取自均衡基线 25%：单项过半即单修，前二合计高且差距小算双修。
    """
    k1, k2 = ordered[0][0], ordered[1][0]
    s1, s2 = shares[k1], shares[k2]
    if s1 >= 0.55:
        return f"极端{CN[k1]}"
    if s1 + s2 >= 0.72 and (s1 - s2) <= 0.15:
        return f"双修 {CN[k1]}+{CN[k2]}"
    if s1 >= 0.40:
        return f"主{CN[k1]}"
    if s1 <= 0.30:
        return "均衡"
    return f"偏{CN[k1]}"


def focus_index(shares):
    """专精度 0~1：0=四维完全均衡，1=全部堆在一项（归一化 HHI）。"""
    hhi = sum(s * s for s in shares.values())
    return max(0.0, (hhi - 0.25) / 0.75)


def stacked_bar(shares, width=24):
    """四维占比堆叠条，按 ATTRS 顺序，末段补齐宽度。"""
    cells = []
    for i, (k, _cn, ch) in enumerate(ATTRS):
        cells.append(int(round(shares[k] * width)) if i < len(ATTRS) - 1 else 0)
    cells[-1] = max(0, width - sum(cells[:-1]))
    return "".join(BAR[ATTRS[i][0]] * cells[i] for i in range(len(ATTRS)))


def analyze(member, stats):
    """把一名成员的原始 statistics 归约成分析记录。"""
    rk = (stats or {}).get("rankings") or {}
    vals = {k: 0 for k in KEYS}
    ranks = {k: None for k in KEYS}
    for a in rk.get("attributes") or []:
        cat = str(a.get("category") or "")
        if not cat.startswith("attribute:"):
            continue
        key = cat.split(":", 1)[1]
        if key in vals:
            vals[key] = a.get("value") or 0
            ranks[key] = a.get("rank")

    total = sum(vals.values())
    shares = {k: (vals[k] / total if total else 0.0) for k in KEYS}
    ordered = sorted(vals.items(), key=lambda kv: kv[1], reverse=True)
    top_key = ordered[0][0]

    return {
        "publicId": member.get("publicId"),
        "nickname": member.get("nickname") or "?",
        "level": member.get("level") or 0,
        "role": member.get("role") or "member",
        "contribution": member.get("lifetimeContribution") or 0,
        "biomeId": member.get("currentBiomeId"),
        "values": vals,
        "ranks": ranks,
        "shares": shares,
        "total": total,
        "topKey": top_key,
        "topShare": shares[top_key],
        "focus": focus_index(shares),
        "style": classify(shares, ordered) if total else "无数据",
    }


def summarize(recs):
    """公会层面的聚合。"""
    valid = [r for r in recs if r["total"] > 0]
    totals = {k: sum(r["values"][k] for r in valid) for k in KEYS}
    grand = sum(totals.values())
    per_dim = {}
    for k in KEYS:
        vs = [r["values"][k] for r in valid] or [0]
        rs = [r["ranks"][k] for r in valid if r["ranks"][k]]
        per_dim[k] = {
            "total": totals[k],
            "share": totals[k] / grand if grand else 0.0,
            "avg": sum(vs) / len(vs),
            "max": max(vs),
            "min": min(vs),
            "bestRank": min(rs) if rs else None,
            "avgRank": sum(rs) / len(rs) if rs else None,
        }
    faction = {k: sum(1 for r in valid if r["topKey"] == k) for k in KEYS}
    styles = {}
    for r in valid:
        styles[r["style"]] = styles.get(r["style"], 0) + 1
    return {
        "counted": len(valid),
        "grandTotal": grand,
        "perDim": per_dim,
        "faction": faction,
        "styles": styles,
        "avgFocus": sum(r["focus"] for r in valid) / len(valid) if valid else 0.0,
    }


# ---------- 输出 ----------

def render(guild, recs, summary, failures, top_n, sort_key):
    out = []
    gname = guild.get("name") or "?"
    tag = guild.get("tag")
    out.append("")
    out.append(f"公会 [{tag}] {gname}  #{guild.get('publicId')}")
    out.append(f"等级 {guild.get('level')} | 成员 {guild.get('memberCount')}/{guild.get('memberCapacity')} "
               f"| 经验 {n(guild.get('experience'))}/{n(guild.get('experienceToNextLevel'))} "
               f"| 已分析 {summary['counted']} 人")
    if guild.get("publicDescription"):
        out.append(f"简介: {clip(guild['publicDescription'], 76)}")

    # ---- 1. 成员四维总表 ----
    reverse = True
    if sort_key == "level":
        keyfn = lambda r: r["level"]           # noqa: E731
    elif sort_key == "contribution":
        keyfn = lambda r: r["contribution"]    # noqa: E731
    elif sort_key == "focus":
        keyfn = lambda r: r["focus"]           # noqa: E731
    elif sort_key in KEYS:
        keyfn = lambda r: r["values"][sort_key]  # noqa: E731
    else:
        keyfn = lambda r: r["total"]           # noqa: E731
    ordered = sorted(recs, key=keyfn, reverse=reverse)

    rows = []
    for i, r in enumerate(ordered, 1):
        rows.append([
            str(i), clip(r["nickname"], 16), ROLE_CN.get(r["role"], r["role"]),
            n(r["level"]),
            n(r["values"]["strength"]), n(r["values"]["luck"]),
            n(r["values"]["intelligence"]), n(r["values"]["endurance"]),
            n(r["total"]), CN[r["topKey"]], pct(r["topShare"]), r["style"],
        ])
    out.append("")
    out.append(f"■ 成员四维总表（按 {sort_key} 降序）")
    out.append(table(
        ["#", "昵称", "职位", "等级", "力量", "运气", "智力", "耐力", "总计", "主属性", "主占比", "流派"],
        rows,
        ["r", "l", "l", "r", "r", "r", "r", "r", "r", "c", "r", "l"]))

    # ---- 2. 四维分布图 ----
    out.append("")
    out.append("■ 四维分布图  " + "  ".join(f"{BAR[k]}{CN[k]}" for k in KEYS))
    bar_rows = []
    for r in sorted(recs, key=lambda x: x["total"], reverse=True):
        bar_rows.append([clip(r["nickname"], 16), stacked_bar(r["shares"]),
                         pct(r["focus"], 0), r["style"]])
    out.append(table(["昵称", "力量▏运气▏智力▏耐力", "专精度", "流派"],
                     bar_rows, ["l", "l", "r", "l"]))

    # ---- 3. 各维 TOP N ----
    tops = {k: sorted(recs, key=lambda r: r["values"][k], reverse=True)[:top_n] for k in KEYS}
    rows = []
    for i in range(top_n):
        row = [str(i + 1)]
        for k in KEYS:
            if i < len(tops[k]) and tops[k][i]["values"][k] > 0:
                r = tops[k][i]
                row.append(f"{clip(r['nickname'], 10)} {n(r['values'][k])}")
            else:
                row.append("-")
        rows.append(row)
    out.append("")
    out.append(f"■ 各维 TOP {top_n}")
    out.append(table(["#"] + [CN[k] for k in KEYS], rows, ["r", "l", "l", "l", "l"]))

    # ---- 4. 公会四维合计 ----
    rows = []
    for k in KEYS:
        d = summary["perDim"][k]
        rows.append([CN[k], n(d["total"]), pct(d["share"]), n(round(d["avg"])),
                     n(d["max"]), n(d["min"]),
                     f"#{d['bestRank']}" if d["bestRank"] else "-",
                     f"#{round(d['avgRank'])}" if d["avgRank"] else "-"])
    out.append("")
    out.append("■ 公会四维合计（排名为全服）")
    out.append(table(["属性", "合计", "占比", "人均", "最高", "最低", "最佳排名", "平均排名"],
                     rows, ["c", "r", "r", "r", "r", "r", "r", "r"]))

    # ---- 5. 流派分布 ----
    rows = []
    for k in KEYS:
        c = summary["faction"][k]
        names = [r["nickname"] for r in recs if r["total"] and r["topKey"] == k]
        rows.append([CN[k], str(c),
                     pct(c / summary["counted"]) if summary["counted"] else "-",
                     clip("、".join(names) or "-", 48)])
    out.append("")
    out.append("■ 主属性阵营分布")
    out.append(table(["主属性", "人数", "占比", "成员"], rows, ["c", "r", "r", "l"]))

    rows = [[s, str(c), pct(c / summary["counted"]) if summary["counted"] else "-"]
            for s, c in sorted(summary["styles"].items(), key=lambda kv: -kv[1])]
    out.append("")
    out.append("■ 流派分布")
    out.append(table(["流派", "人数", "占比"], rows, ["l", "r", "r"]))

    # ---- 6. 极值 ----
    valid = [r for r in recs if r["total"] > 0]
    if valid:
        most = max(valid, key=lambda r: r["focus"])
        even = min(valid, key=lambda r: r["focus"])
        fat = max(valid, key=lambda r: r["total"])
        out.append("")
        out.append(f"■ 公会整体专精度 {pct(summary['avgFocus'], 0)}"
                   f" | 四维总量 {n(summary['grandTotal'])}")
        out.append(f"  最专精: {most['nickname']}（{most['style']}，专精度 {pct(most['focus'], 0)}）")
        out.append(f"  最均衡: {even['nickname']}（{even['style']}，专精度 {pct(even['focus'], 0)}）")
        out.append(f"  最肥号: {fat['nickname']}（四维总计 {n(fat['total'])}）")

    if failures:
        out.append("")
        out.append(f"■ 失败 {len(failures)} 人（未计入统计）")
        for pid, name, err in failures:
            out.append(f"  - {name} #{pid}: {clip(str(err), 90)}")

    out.append("")
    return "\n".join(out)


def write_csv(path, recs):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["publicId", "昵称", "职位", "等级", "贡献",
                    "力量", "运气", "智力", "耐力", "总计",
                    "力量占比", "运气占比", "智力占比", "耐力占比",
                    "力量排名", "运气排名", "智力排名", "耐力排名",
                    "主属性", "主占比", "专精度", "流派"])
        for r in sorted(recs, key=lambda x: x["total"], reverse=True):
            w.writerow([r["publicId"], r["nickname"], ROLE_CN.get(r["role"], r["role"]),
                        r["level"], r["contribution"]]
                       + [r["values"][k] for k in KEYS]
                       + [r["total"]]
                       + [round(r["shares"][k], 4) for k in KEYS]
                       + [r["ranks"][k] or "" for k in KEYS]
                       + [CN[r["topKey"]], round(r["topShare"], 4),
                          round(r["focus"], 4), r["style"]])


# ---------- CLI ----------

def main():
    p = argparse.ArgumentParser(
        description="分析公会全体成员的四维属性（力量/运气/智力/耐力）与流派偏向")
    p.add_argument("guild", help="公会 ID 或链接，如 10013 / https://reelax.cn/guilds/10013")
    p.add_argument("--top", type=int, default=5, help="各维 TOP 榜条数（默认 5）")
    p.add_argument("--sort", default="total",
                   choices=["total", "level", "contribution", "focus"] + KEYS,
                   help="总表排序字段（默认 total）")
    p.add_argument("--delay", type=float, default=0.35, help="请求间隔基数秒（默认 0.35）")
    p.add_argument("--jitter", type=float, default=0.35, help="间隔随机抖动上限秒（默认 0.35）")
    p.add_argument("--timeout", type=int, default=25, help="单次桥接超时秒（默认 25）")
    p.add_argument("--bridge-port", type=int, default=None, help="桥端口（默认同 api.py）")
    p.add_argument("--json", dest="json_path", help="把完整分析结果写入 JSON 文件")
    p.add_argument("--csv", dest="csv_path", help="把成员明细写入 CSV 文件")
    p.add_argument("--stdout-json", action="store_true", help="只向 stdout 输出 JSON，不打印表格")
    p.add_argument("--quiet", action="store_true", help="不打印抓取进度")
    args = p.parse_args()

    gid = parse_guild_id(args.guild)
    api = ReelaxApi(timeout=args.timeout, port=args.bridge_port)
    f = Fetcher(api, delay=args.delay, jitter=args.jitter,
                quiet=args.quiet or args.stdout_json)

    f.log(f"→ 公会 #{gid} 概况…")
    guild = f.guild(gid)
    f.pace()

    f.log("→ 成员列表…")
    members = f.members(gid)
    f.log(f"  共 {len(members)} 名成员")

    recs, failures = [], []
    for i, m in enumerate(members, 1):
        pid, nick = m.get("publicId"), m.get("nickname")
        f.pace()
        try:
            stats = f.player_stats(pid)
            rec = analyze(m, stats)
            recs.append(rec)
            f.log(f"  [{i}/{len(members)}] {nick} #{pid} → 总计 {n(rec['total'])} "
                  f"（{CN[rec['topKey']]} {pct(rec['topShare'])}，{rec['style']}）")
        except Exception as e:
            failures.append((pid, nick, e))
            f.log(f"  [{i}/{len(members)}] {nick} #{pid} → 失败: {e}")

    if not recs:
        print("没有取到任何成员数据，检查扩展桥是否正常（python3 api.py me）", file=sys.stderr)
        sys.exit(1)

    summary = summarize(recs)
    payload = {
        "guild": guild,
        "summary": summary,
        "members": sorted(recs, key=lambda r: r["total"], reverse=True),
        "failures": [{"publicId": pid, "nickname": nick, "error": str(err)}
                     for pid, nick, err in failures],
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    if args.stdout_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(render(guild, recs, summary, failures, args.top, args.sort))

    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        f.log(f"✓ JSON 已写入 {args.json_path}")
    if args.csv_path:
        write_csv(args.csv_path, recs)
        f.log(f"✓ CSV 已写入 {args.csv_path}")


if __name__ == "__main__":
    main()
