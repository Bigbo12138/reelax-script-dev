# fish_market.py —— 鱼类市场策略（税后模型）
#
# 只做提醒类决策：
#   1. 我的库存：挂市场 vs 卖 NPC 的决策（税后净得对比）。
#   2. 行情异动：24h 价格波动超过阈值提醒。
#   3. 套利候选：挂单（卖）深度下的潜在低买高卖（仅提醒，不执行）。
import logging

from . import alerts, config, pricing, store
from .api_client import MarketApi

log = logging.getLogger("market.fish")


def scan(api: MarketApi, dry_run=True, send_alerts=True):
    """跑一轮鱼类市场扫描。返回结果 dict。"""
    overview = api.market_fish_overview()
    price_map = {}
    change_map = {}
    for f in overview.get("fish") or []:
        if f.get("latestTradeUnitPrice") is not None:
            price_map[f["fishId"]] = f["latestTradeUnitPrice"]
        if f.get("priceChange24hBasisPoints"):
            change_map[f["fishId"]] = f["priceChange24hBasisPoints"]

    # 行情异动
    movers = []
    for fid, bps in change_map.items():
        if abs(bps) >= config.FISH_MARKET_PRICE_CHANGE_ALERT_BPS:
            movers.append({"fishId": fid, "price": price_map.get(fid),
                           "changeBps": bps})

    # 我的库存卖出决策
    inv = api.inventory_fish(limit=200)
    sell_plan = []
    for f in inv.get("fish") or []:
        if f.get("isLocked") or (f.get("quantity") or 0) <= 0:
            continue
        fid = f["fishId"]
        market = price_map.get(fid)
        npc = f.get("sellPrice")
        if not npc:
            continue
        kind, net = pricing.fish_sell_decision(market, npc)
        if kind == "list":
            sell_plan.append({"fishId": fid, "name": f.get("name"),
                              "qty": f.get("quantity"), "market": market,
                              "npc": npc, "net_after_tax": net})
        # 记录参考价
        store.save_fish_price(fid, market if market else npc, "overview")

    # 套利候选（模拟：取我库存鱼的挂单卖单）
    arb = []
    # 只对有一定库存的鱼查 order-book，控制请求量
    for f in inv.get("fish") or []:
        fid = f["fishId"]
        if (f.get("quantity") or 0) < 10:
            continue
        if len(arb) >= 5:
            break
        try:
            book = api.market_order_book(fid)
        except Exception as e:
            log.debug("[fish] order-book %s 失败: %s", fid, e)
            continue
        sells = [o for o in (book.get("sellOrders") or [])
                 if o.get("limitUnitPrice")]
        if not sells:
            continue
        best = min(sells, key=lambda o: o["limitUnitPrice"])
        net = pricing.fish_arb_net(price_map.get(fid), best["limitUnitPrice"])
        if net >= config.FISH_MARKET_MIN_ARB_PROFIT:
            arb.append({"fishId": fid, "name": f.get("name"),
                        "buy_price": best["limitUnitPrice"],
                        "ref_sell": price_map.get(fid), "net_after_tax": net})

    result = {"movers": movers, "sell_plan": sell_plan, "arb": arb}

    log.info("[fish] 异动 %d 条 / 建议挂单 %d 条 / 套利候选 %d 条",
             len(movers), len(sell_plan), len(arb))
    for m in movers:
        log.info("[fish] 异动 %s 24h变动 %+.2f%% 现价 %s",
                 m["fishId"], m["changeBps"] / 100, m["price"])

    if not dry_run and send_alerts:
        for m in movers:
            alerts.send_alert(
                "fish_price_move",
                "鱼类价格异动",
                f"**{m['fishId']}** 24h 变动 **%+.2f%%**（现价 {m['price']}）"
                % (m["changeBps"] / 100))
        for a in arb:
            alerts.send_alert(
                "fish_arb",
                "鱼类套利候选",
                (f"买 **{a['name']}** @{a['buy_price']:,}\n"
                 f"> 参考卖价 {a['ref_sell']:,}，税后净利 **+{a['net_after_tax']:,}**"),
                dedup_order_id=f"arb:{a['fishId']}")

    return result


def refresh_trades(api: MarketApi):
    """增量拉取我的鱼类市场成交记录入库。"""
    data = api.market_my_trades(limit=50)
    added = 0
    from datetime import datetime
    for t in data.get("trades") or []:
        ts = datetime.fromisoformat(t["createdAt"].replace("Z", "+00:00")).timestamp()
        if store.upsert_trade("fish_market", t["id"], ts, t):
            added += 1
    log.info("[fish] 鱼类市场成交新增 %d 条", added)
    return added
