# barter_scanner.py —— 以物换物策略（专精鱼导向）
#
# 流程：专精需求集 → 逐个目标鱼查公开订单 → 用我的库存判定可填 → 评分 → 提醒/填单。
import logging
from datetime import datetime

from . import alerts, config, executor, mastery, pricing, store
from .api_client import MarketApi

log = logging.getLogger("market.barter")


def build_inventory_map(inventory_data):
    """/api/inventory/fish -> {fishId: {quantity, sellPrice, name, rarity, isLocked}}"""
    m = {}
    for f in inventory_data.get("fish") or []:
        m[f["fishId"]] = f
    return m


def build_overview_price_map(overview_data):
    """/api/market/fish/overview -> {fishId: latestTradeUnitPrice}"""
    m = {}
    for f in overview_data.get("fish") or []:
        if f.get("latestTradeUnitPrice") is not None:
            m[f["fishId"]] = f["latestTradeUnitPrice"]
    return m


def evaluate_order(order, inv_map, price_map, targets_by_id):
    """评估一张公开订单，返回候选列表。

    每张单可存在多组（给1条 requests 鱼 -> 换1条 offers 鱼）的配对；
    取评分最高的一组返回，评分<=阈值或不可填返回空。
    """
    candidates = []
    for req in order.get("requests") or []:
        req_fish = req.get("fish") or {}
        req_id = req_fish.get("fishId")
        if not req_id or (req.get("remainingQuantity") or 0) <= 0:
            continue
        inv = inv_map.get(req_id)
        if not inv:
            continue  # 我根本没有这条鱼
        if inv.get("isLocked"):
            # 锁定的鱼交易不出去。isMasteryLocked 的尤其危险：那是系统替我留着凑
            # 专精的鱼，库存往往很大，不排除就会被评分优先选中当「给出鱼」。
            continue
        if (inv.get("quantity") or 0) <= config.BARTER_KEEP_MIN:
            continue  # 库存没超过保留下限，不给出

        give_base = pricing.fish_base_value(req_id, price_map.get(req_id),
                                            inv.get("sellPrice"))
        give_remaining = (req.get("remainingQuantity") or 0)

        for off in order.get("offers") or []:
            off_fish = off.get("fish") or {}
            off_id = off_fish.get("fishId")
            if not off_id or (off.get("remainingQuantity") or 0) <= 0:
                continue
            off_inv = inv_map.get(off_id)
            # 获得鱼：若是专精目标，叠加专精溢价
            tgt = targets_by_id.get(off_id)
            take_remaining = tgt["remaining"] if tgt else None
            take_value = pricing.fish_value(
                off_id,
                price_map.get(off_id),
                off_inv.get("sellPrice") if off_inv else None,
                mastery_remaining=take_remaining)

            score = pricing.barter_pair_score(
                give_base, take_value, inv.get("quantity") or 0)
            if score is None:
                continue
            candidates.append({
                "order_id": order.get("id"),
                "owner": order.get("ownerNickname"),
                "give_fish_id": req_id,
                "give_name": req_fish.get("name"),
                "give_remaining": give_remaining,
                "give_inv_qty": inv.get("quantity"),
                "give_value": give_base,
                "take_fish_id": off_id,
                "take_name": off_fish.get("name"),
                "take_rarity": off_fish.get("rarity"),
                "take_is_mastery_target": bool(tgt),
                "take_value": take_value,
                "score": score,
            })

    if not candidates:
        return []
    candidates.sort(key=lambda c: c["score"], reverse=True)
    return candidates[:1]  # 每张单最多报一个最优配对


def scan(api: MarketApi, dry_run=True, send_alerts=True, fill=False):
    """跑一轮 barter 扫描。返回候选列表。

    - dry_run=True：只读，不提醒不执行（默认，用于测试）。
    - send_alerts=True：候选通过 webhook 提醒（带订单去重）。
    - fill=True：执行填单（需 force，见 Executor）。
    """
    # 1) 专精需求集
    mastery_data = api.mastery()
    targets = mastery.extract_targets(mastery_data)
    log.info("[barter] 专精需求 %d 个，单轮扫前 %d 个",
             len(targets), config.BARTER_MAX_TARGETS_PER_SCAN)
    if not targets:
        log.info("[barter] 没有未完成的专精目标，结束")
        return []
    targets_by_id = {t["fishId"]: t for t in targets}

    # 2) 我的库存 + 市场参考价
    inv_map = build_inventory_map(api.inventory_fish(limit=200))
    price_map = build_overview_price_map(api.market_fish_overview())

    # 3) 逐个目标鱼扫订单
    candidates = []
    for t in targets[:config.BARTER_MAX_TARGETS_PER_SCAN]:
        log.info("[barter] 扫目标 %s(%s) 剩余 %d",
                 t["fishName"], t["fishId"], t["remaining"])
        try:
            data = api.barter_orders(can_fulfill=True,
                                     offers_mastery=config.BARTER_OFFERS_MASTERY,
                                     target_fish_id=t["fishId"],
                                     limit=config.BARTER_PAGE_SIZE)
        except Exception as e:
            log.warning("[barter] 查询 %s 失败: %s", t["fishId"], e)
            continue
        found = 0
        for order in data.get("orders") or []:
            if order.get("isOwnOrder"):
                continue
            for c in evaluate_order(order, inv_map, price_map, targets_by_id):
                c["target_fish"] = t["fishId"]
                c["target_name"] = t["fishName"]
                candidates.append(c)
                found += 1
        if found:
            log.info("[barter] %s 命中 %d 条", t["fishName"], found)

    # 4) 过滤评分阈值 + 输出
    hits = [c for c in candidates if c["score"] > config.BARTER_MIN_SCORE]
    hits.sort(key=lambda c: c["score"], reverse=True)
    for c in hits:
        line = (f"换 {c['take_name']}({c['take_rarity']}) "
                f"给出 {c['give_name']}×1  评分 +{c['score']:,}")
        log.info("[barter] ★ %s", line)

    if not dry_run and send_alerts:
        for c in hits:
            alerts.send_alert(
                "barter_deal",
                "以物换物好单",
                (f"获得 **{c['take_name']}**（{c['take_rarity']}"
                 + ("，**专精目标**" if c["take_is_mastery_target"] else "") + "）\n"
                 f"> 给出：{c['give_name']}×1（库存 {c['give_inv_qty']}）\n"
                 f"> 评分：+{c['score']:,}\n"
                 f"> 单主：{c['owner']}"),
                dedup_order_id=c["order_id"])

    if fill and hits:
        ex = executor.Executor(api, force=True)
        for c in hits[:1]:  # 保守：一轮最多自动填一单
            ex.fill_barter({"id": c["order_id"], "ownerNickname": c["owner"]},
                           c["give_fish_id"], c["take_fish_id"])

    return hits


def refresh_trades(api: MarketApi):
    """增量拉取我的 barter 成交记录入库。"""
    data = api.barter_my_trades(limit=30)
    added = 0
    for t in data.get("trades") or []:
        ts = datetime.fromisoformat(t["createdAt"].replace("Z", "+00:00")).timestamp()
        if store.upsert_trade("barter", t["id"], ts, t):
            added += 1
    log.info("[barter] 成交记录新增 %d 条", added)
    return added
