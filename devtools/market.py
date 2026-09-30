#!/usr/bin/env python3
# market.py —— 查询 reelax.cn 交易市场（走 WS 扩展桥，只读）
#
# 签名由扩展在页面上下文完成（见 SKILL.md「WS 桥教程」），本脚本只把参数
# 映射成 API 查询并发给桥。原实现走 RDP + 注入 sign.js，会踩 RDP 返回截断 /
# 残留 `window.__rdpAsync` 的坑（页面请求一卡就会读到上次的旧值），
# 已改为与 guild_stats.py 一致地走 api.py 的 WS 桥（ReelaxApi.market_orders）。
#
# 用法：
#   python3 market.py                                  # 默认：legendary 装备卖单，单价 ≤ 50 万
#   python3 market.py --asset gear --rarities legendary --max-price 500000
#   python3 market.py --side buy --asset fish --limit 5
#   python3 market.py --raw                            # 打印原始 JSON
#   python3 market.py --bridge-port 55004              # 指定桥端口（默认同 api.py）
#
# 依赖：仅标准库 + 同目录 api.py（需 run.sh 已启动 Firefox 且扩展 bridge.js 已加载）。

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import ReelaxApi  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="查询 reelax.cn 交易市场（走 WS 扩展桥）")
    p.add_argument("--asset", default="gear", help="fish | gear | item")
    p.add_argument("--side", default="sell", help="buy | sell")
    p.add_argument("--rarities", default="legendary", help="稀有度，逗号分隔，如 legendary,mythic")
    p.add_argument("--rarity", default=None, help="单稀有度(单值)")
    p.add_argument("--min-price", type=int, default=None, help="最低价(金币)")
    p.add_argument("--max-price", type=int, default=500000, help="最高价(金币)")
    p.add_argument("--slot", default=None, help="部位 head/chest/legs/.../ring/amulet/charm")
    p.add_argument("--stat", default=None, help="生效属性 strength/intelligence/luck/endurance")
    p.add_argument("--min-quality", type=int, default=None, help="最低品质 0-100")
    p.add_argument("--min-upgrade", type=int, default=None, help="最低强化 0-10")
    p.add_argument("--sort", default="rarity", help="排序字段")
    p.add_argument("--direction", default="desc", help="asc | desc")
    p.add_argument("--limit", type=int, default=10, help="返回条数(≤100)")
    p.add_argument("--cursor", default=None, help="分页游标")
    p.add_argument("--timeout", type=int, default=25, help="单次桥接超时秒（默认 25）")
    p.add_argument("--bridge-port", type=int, default=None, help="桥端口（默认同 api.py）")
    p.add_argument("--raw", action="store_true", help="打印原始 JSON")
    args = p.parse_args()

    rarities = [r.strip() for r in args.rarities.split(",") if r.strip()] if args.rarities else None

    api = ReelaxApi(timeout=args.timeout, port=args.bridge_port)
    try:
        data = api.market_orders(
            asset_type=args.asset, side=args.side,
            rarities=rarities, rarity=args.rarity,
            min_price=args.min_price, max_price=args.max_price,
            slot=args.slot, stat=args.stat,
            min_quality=args.min_quality, min_upgrade=args.min_upgrade,
            sort=args.sort, direction=args.direction,
            limit=args.limit, cursor=args.cursor,
        )
    except Exception as e:
        print(f"❌ 查询失败: {e}", file=sys.stderr)
        sys.exit(1)

    if args.raw:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return

    orders = (data or {}).get("orders")
    if not orders:
        print("（无订单 / 返回体如下）")
        print(json.dumps(data, ensure_ascii=False)[:800])
        return

    print(f"📦 共 {len(orders)} 条订单:\n")
    for o in orders:
        asset = o.get("asset", {})
        gear = asset.get("gear") or asset.get("fish") or asset.get("item") or {}
        name = gear.get("name") or "(未知物品)"
        rarity = gear.get("rarity") or o.get("rarity") or ""
        price = o.get("limitUnitPrice")
        owner = o.get("ownerNickname") or "(匿名)"
        qty = o.get("remainingQuantity", "?")
        print(f"  · {name}  [{rarity}]")
        print(f"      卖家: {owner}  单价: {price:,} 金币  余量: {qty}")
        print(f"      订单ID: {o.get('id')}")


if __name__ == "__main__":
    main()
