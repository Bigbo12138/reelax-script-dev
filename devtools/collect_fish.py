"""采集 Reelax 全部鱼种，生成「一键市场.js」的 HARD_FISH 硬编码表。

用法：
    python3 devtools/collect_fish.py              # 打印 HARD_FISH 字面量到 stdout
    python3 devtools/collect_fish.py -o out.js    # 直接写文件（可整段拷进一键市场.js）

前置：先 `python3 devtools/api.py serve` 起桥，并打开已登录游戏页
（桥的签名请求依赖可注入的游戏页，否则全部 bridge-timeout）。

生成后按下方「替换」把整段 HARD_FISH 覆盖 一键市场.js 里的旧表
（含头注释行起、到闭合 `];` 止），再 `node --check`。
"""
import json
import sys
import time

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0])
import api  # noqa: E402


def main():
    out = None
    if len(sys.argv) >= 3 and sys.argv[1] == "-o":
        out = sys.argv[2]

    a = api.ReelaxApi(timeout=25)
    d = a.biomes()
    biomes = d.get("biomes") or []
    bids = [b.get("biomeId") or b.get("id") for b in biomes if (b.get("biomeId") or b.get("id"))]

    pairs = []
    for bid in bids:
        try:
            fp = a._get("/api/fishpedia?biomeId=" + api._qval(bid))
        except Exception as exc:  # noqa: BLE001
            print("ERR", bid, exc, file=sys.stderr)
            time.sleep(1)
            continue
        uw = fp.get("data", fp) if isinstance(fp, dict) else fp
        fish = uw.get("fish") if isinstance(uw, dict) else None
        if not fish:
            print("SHAPE", bid, list(uw.keys()) if isinstance(uw, dict) else type(uw).__name__, file=sys.stderr)
            time.sleep(0.8)
            continue
        for f in fish:
            if f and f.get("fishId") and f.get("name"):
                pairs.append((f["fishId"], str(f["name"])))
        time.sleep(0.6)

    seen = {}
    for fid, name in pairs:
        seen.setdefault(fid, name)
    items = sorted(seen.items(), key=lambda kv: kv[0].split("_"))

    counts = {}
    for fid, _ in items:
        counts[fid.split("_")[2] if len(fid.split("_")) >= 3 else "?"] = counts.get(
            fid.split("_")[2] if len(fid.split("_")) >= 3 else "?", 0
        ) + 1

    lines = []
    lines.append("  const HARD_FISH = [")
    for fid, name in items:
        lines.append("    ['%s', '%s']," % (fid, name))
    lines.append("  ];")

    hdr = (
        "  // 鱼种硬编码表 [fishId, name] —— 由 devtools/collect_fish.py 从 /api/fishpedia 采集"
        "（共 %d 种，b_001–b_015）。游戏更新鱼种后重跑 collect_fish.py 重新生成。"
        % len(items)
    )
    body = "\n".join(lines)
    text = hdr + "\n" + body

    print("TOTAL_FISH", len(items), file=sys.stderr)
    print("COUNTS", counts, file=sys.stderr)

    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print("WROTE", out, file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()