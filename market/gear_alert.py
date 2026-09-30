# gear_alert.py —— 装备市场低价提醒（只提醒，不买入）
#
# 流程：扫 legendary/mythic 低价卖单 → 与参考价（同 rarity+slot(+stat)
# 的历史成交中位数）比较 → 低估程度超阈值 → webhook 提醒。
# 本期不做自动买入、不做估价模型，留待二期（见设计稿 §1.3 / §3.4）。
import logging
import time
from datetime import datetime

from . import alerts, config, store
from .api_client import MarketApi

log = logging.getLogger("market.gear")

_PRICE_KEYS = ("limitUnitPrice", "unitPrice", "executedUnitPrice", "price")
_UPGRADE_KEYS = ("minUpgradeLevel", "upgradeLevel", "level")


def _find_gear(obj):
    """递归找出装备子对象（订单/成交对象里形如 {rarity, slot, ...} 的 dict）。

    兼容 `order.asset.gear`、`order.gear`、或整块就是 gear 的情况。
    """
    if isinstance(obj, dict):
        g = obj.get("gear")
        if isinstance(g, dict) and ("rarity" in g or "slot" in g or "quality" in g):
            return g
        if "rarity" in obj and "slot" in obj:
            return obj
        for v in obj.values():
            found = _find_gear(v)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_gear(v)
            if found:
                return found
    return None


def _find_price(obj):
    """从订单/成交对象根部取单价；只有总额+数量时折算单价。"""
    for k in _PRICE_KEYS:
        v = obj.get(k)
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    total = obj.get("totalPrice")
    qty = obj.get("quantity")
    if total is not None and qty:
        try:
            return int(int(total) / int(qty))
        except (TypeError, ValueError, ZeroDivisionError):
            pass
    return None


def _upgrade(gear):
    for k in _UPGRADE_KEYS:
        if gear.get(k) is not None:
            return gear[k]
    return None


def _gear_key(gear):
    """参考价档位键：rarity + slot（+ stat）。关键维度缺失则返回 None。"""
    rarity = gear.get("rarity")
    slot = gear.get("slot")
    if not rarity or not slot:
        return None
    return (rarity, slot, gear.get("stat"))


def extract_trade(trade):
    """从一条成交记录提取 (gear_key, 单价)。解析不了返回 None。"""
    gear = _find_gear(trade)
    if gear is None:
        return None
    key = _gear_key(gear)
    price = _find_price(trade)
    if not key or not price:
        return None
    return key, price


def build_reference():
    """从本地成交库构建参考价：{gear_key: 中位价}。

    只统计 GEAR_REF_LOOKBACK_HOURS 内的成交（老价格会拖偏参考价）；
    同档位样本数 < GEAR_REF_MIN_SAMPLES 时不进参考价（由调用方回退默认值），
    避免单笔成交把参考价带偏。
    """
    cutoff = time.time() - config.GEAR_REF_LOOKBACK_HOURS * 3600
    samples = {}
    for ts, data in store.recent_trades("gear_market", limit=500):
        if ts < cutoff:
            continue
        item = extract_trade(data)
        if item is None:
            continue
        key, price = item
        samples.setdefault(key, []).append(price)

    ref = {}
    for key, prices in samples.items():
        if len(prices) >= config.GEAR_REF_MIN_SAMPLES:
            prices.sort()
            ref[key] = prices[len(prices) // 2]
    return ref


def evaluate_order(order, ref):
    """评估一张装备卖单，返回命中信息；未命中返回 None。"""
    gear = _find_gear(order)
    if gear is None:
        return None
    price = _find_price(order)
    if not price:
        return None
    key = _gear_key(gear)
    ref_price = ref.get(key) if key else None
    if not ref_price:
        ref_price = config.GEAR_REF_PRICE_FALLBACK

    # 低估程度 = 1 − 挂单价 / 参考价（挂单价越低，低估程度越大）
    discount = 1 - price / ref_price
    if discount < config.GEAR_ALERT_DISCOUNT_RATIO:
        return None
    return {
        "order_id": order.get("id"),
        "owner": order.get("ownerNickname"),
        "name": gear.get("name"),
        "rarity": gear.get("rarity"),
        "slot": gear.get("slot"),
        "stat": gear.get("stat"),
        "quality": gear.get("quality"),
        "upgrade": _upgrade(gear),
        "price": price,
        "ref_price": ref_price,
        "discount": discount,
    }


def scan(api: MarketApi, dry_run=True, send_alerts=True):
    """跑一轮装备低价提醒。返回命中列表。

    - dry_run=True：只读，不提醒（默认，用于测试）。
    - send_alerts=True：命中通过 webhook 提醒（带订单去重）。
    """
    ref = build_reference()
    log.info("[gear] 参考价档位 %d 组", len(ref))

    data = api.market_orders(
        asset_type="gear", side="sell",
        rarities=config.GEAR_ALERT_RARITIES,
        max_price=config.GEAR_ALERT_MAX_PRICE,
        limit=config.GEAR_ALERT_PAGE_SIZE)
    orders = data.get("orders") or []
    hits = [h for h in (evaluate_order(o, ref) for o in orders) if h]

    hits.sort(key=lambda h: h["discount"], reverse=True)
    for h in hits:
        log.info("[gear] ★ %s [%s/%s] 挂 %d 参考 %d 低估 %d%%",
                 h["name"], h["rarity"], h["slot"], h["price"],
                 h["ref_price"], int(h["discount"] * 100))

    if not dry_run and send_alerts:
        for h in hits:
            detail = f"[{h['rarity']} · {h['slot']}"
            if h.get("stat"):
                detail += f" · {h['stat']}"
            if h.get("quality") is not None:
                detail += f" · 品质{h['quality']}"
            if h.get("upgrade") is not None:
                detail += f" · 强化{h['upgrade']}"
            alerts.send_alert(
                "gear_discount",
                "装备低价",
                (f"**{h['name']}** {detail}]\n"
                 f"> 挂单价 **{h['price']:,}**，参考价 {h['ref_price']:,}，"
                 f"低估 **{int(h['discount'] * 100)}%**\n"
                 f"> 卖家：{h['owner']}"),
                dedup_order_id=h["order_id"])

    return hits


def refresh_trades(api: MarketApi):
    """增量拉取装备市场成交入库（assetType=gear），供参考价积累。"""
    data = api.market_my_trades(asset_type="gear", limit=50)
    added = 0
    for t in data.get("trades") or []:
        ts = datetime.fromisoformat(t["createdAt"].replace("Z", "+00:00")).timestamp()
        if store.upsert_trade("gear_market", t["id"], ts, t):
            added += 1
    log.info("[gear] 装备成交新增 %d 条", added)
    return added
