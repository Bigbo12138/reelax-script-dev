#!/usr/bin/env python3
# api.py —— 通过浏览器扩展桥读取 reelax.cn 数据（只读 API）
#
# 架构：
#   1. 本脚本在本机 127.0.0.1:55004 起一个 WebSocket 服务端（ws_bridge.py，纯标准库）。
#   2. 扩展（bridge.js，background 脚本）作为 WebSocket 客户端主动连上并保持长连接，
#      在页面上下文签名执行 reelax.cn 请求（扩展有 host 权限 + cookie，写操作也能过
#      Referer 校验），再把结果回传。全双工、无轮询竞态。
#   3. 本脚本通过 ws_bridge.request() 按 id 等结果返回。
#
# 用法（CLI，默认只读；barter-create/fill/cancel 为写操作，会真实改游戏状态）：
#   python3 api.py me
#   python3 api.py market-orders --rarities legendary --max-price 500000 --side sell --limit 10
#   python3 api.py market-config
#   python3 api.py market-fish-overview
#   python3 api.py market-my-orders --limit 10
#   python3 api.py market-my-trades --limit 10
#   python3 api.py fishing-state
#   python3 api.py biomes
#   python3 api.py mastery
#   python3 api.py mastery-talents
#   python3 api.py baits
#   python3 api.py guilds-me
#   python3 api.py inventory-gear --limit 10
#   python3 api.py inventory-fish --limit 100
#   python3 api.py statistics
#   python3 api.py weather --biome b_001
#   python3 api.py raw "/api/market/orders?assetType=gear&side=sell&rarities=legendary"
#   python3 api.py barter-orders --target-fish-id b_004_mythic_02
#   python3 api.py barter-my-orders / barter-my-trades
#   python3 api.py barter-create --requests '[{"fishId":"b_001_common_05","quantity":1}]' --offers '[{"fishId":"b_002_common_04","quantity":1}]'
#   python3 api.py barter-fill --order-id <id> --request-fish-id <给出鱼> --offer-fish-id <获得鱼>
#   python3 api.py barter-cancel --order-id <id>
#   python3 api.py serve            # 只起桥，常驻（供外部脚本反复调用）
#
# 写操作说明：POST/PUT/DELETE 会带签名 + Idempotency-Key（同 payload 重复提交由调用方
# 自行复用 key 保证幂等）；返回原始 {status, ok, data, raw}，status==200 才成功。
#
# 也可作为库：
#   from api import ReelaxApi
#   api = ReelaxApi()
#   print(api.market_orders(rarities=['legendary'], max_price=500000))
#   print(api.biomes())
#
# 依赖：仅标准库。前提：run.sh 已启动 Firefox 并加载本扩展（含 bridge.js）。

import argparse
import json
import sys
import time
import uuid
from urllib.parse import quote

BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 55004


# ---------- 桥：持久 WebSocket（ws_bridge.py）----------
# 扩展后台 bridge.js 作为 WebSocket 客户端连到本机服务端，Python 通过
# ws_bridge.request() 下发 {id, method, path, body}，扩展回传结果。
# 无轮询、无队列竞态，全双工。

import ws_bridge


class Bridge:
    """桥：转发到 ws_bridge（持久 WebSocket）。保持 submit 签名兼容。"""

    def submit(self, path, method="GET", body=None, idempotency_key=None, timeout=20):
        return ws_bridge.request(method, path, body, timeout=timeout)

    def pending(self):
        return ws_bridge.pending_count()


bridge = Bridge()


# ---------- 只读 API 封装 ----------

def _join(vals):
    if not vals:
        return None
    if isinstance(vals, str):
        return vals
    return ",".join(str(v) for v in vals)


def _qval(v):
    """查询参数序列化：Python bool 必须输出小写 true/false（API 枚举只认小写）。"""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


class ReelaxApi:
    """所有方法都是只读 GET，数据来自扩展桥。"""

    def __init__(self, timeout=20, port=None):
        self._timeout = timeout
        self._port = port or BRIDGE_PORT
        ws_bridge.start(port=self._port)

    def _get(self, path, params=None):
        if params:
            q = "&".join(f"{k}={_qval(v)}" for k, v in params.items() if v is not None)
            if q:
                path = path + "?" + q
        res = bridge.submit(path, timeout=self._timeout)
        if res.get("status") != 200:
            raise RuntimeError(f"API {path} -> {res.get('status')}: {res.get('data') or res.get('error')}")
        return res.get("data")

    def _post(self, path, body=None, idempotency_key=None, method="POST"):
        """写操作：返回原始结果 {status, ok, data, raw}，调用方自行判断成功/失败。"""
        if idempotency_key is None:
            idempotency_key = str(uuid.uuid4())
        return bridge.submit(path, method=method, body=body,
                             idempotency_key=idempotency_key, timeout=self._timeout)

    def _raw_ok(self, res, what=""):
        """写操作返回体统一校验：status==200 才返回 data，否则抛 RuntimeError。"""
        if res.get("status") == 200:
            return res.get("data")
        raise RuntimeError(f"{what or '操作'} -> {res.get('status')}: {res.get('data') or res.get('error') or res.get('raw', '')[:200]}")

    # ---- 个人 / 会话 ----
    def me(self):
        return self._get("/api/me")

    # ---- 交易市场 ----
    def market_config(self):
        return self._get("/api/market/config")

    def market_orders(self, asset_type="gear", side=None, rarities=None, rarity=None,
                      min_price=None, max_price=None, slot=None, stat=None,
                      min_quality=None, min_upgrade=None, sort="rarity",
                      direction="desc", limit=20, cursor=None):
        return self._get("/api/market/orders", {
            "assetType": asset_type, "side": side,
            "rarities": _join(rarities), "rarity": rarity,
            "minPrice": min_price, "maxPrice": max_price,
            "slot": slot, "stat": stat,
            "minQuality": min_quality, "minUpgradeLevel": min_upgrade,
            "sort": sort, "direction": direction,
            "limit": limit, "cursor": cursor,
        })

    def market_fish_overview(self):
        return self._get("/api/market/fish/overview")

    def market_my_orders(self, asset_type=None, limit=50, cursor=None):
        return self._get("/api/market/me/orders", {
            "assetType": asset_type, "limit": limit, "cursor": cursor,
        })

    def market_my_trades(self, asset_type=None, limit=50, cursor=None):
        return self._get("/api/market/me/trades", {
            "assetType": asset_type, "limit": limit, "cursor": cursor,
        })

    # ---- 以物换物（barter）只读 ----
    def barter_orders(self, limit=24, can_fulfill=True, offers_mastery=True,
                      target_fish_id=None, cursor=None):
        return self._get("/api/barter/orders", {
            "limit": limit,
            "canFulfill": can_fulfill,
            "offersMastery": offers_mastery,
            "targetFishId": target_fish_id,
            "cursor": cursor,
        })

    def barter_my_orders(self, status="active", limit=24, cursor=None):
        return self._get("/api/barter/me/orders", {
            "status": status, "limit": limit, "cursor": cursor,
        })

    def barter_my_trades(self, limit=30, cursor=None):
        return self._get("/api/barter/me/trades", {
            "limit": limit, "cursor": cursor,
        })

    # ---- 以物换物（barter）写操作 ----
    def barter_create_order(self, requests, offers, idempotency_key=None):
        """requests/offers: [{fishId, quantity}, ...]。返回完整结果。"""
        return self._post("/api/barter/orders",
                          {"requests": requests, "offers": offers},
                          idempotency_key)

    def barter_fill_order(self, order_id, request_fish_id, offer_fish_id, idempotency_key=None):
        return self._post(
            f"/api/barter/orders/{quote(order_id, safe='')}/fill",
            {"orderId": order_id,
             "requestFishId": request_fish_id,
             "offerFishId": offer_fish_id},
            idempotency_key)

    def barter_cancel_order(self, order_id, idempotency_key=None):
        return self._post(f"/api/barter/orders/{quote(order_id, safe='')}",
                          None, idempotency_key, method="DELETE")

    # ---- 市场写操作（鱼/装备挂单、购买、撤单） ----
    def market_create_order(self, asset_type, side, limit_unit_price,
                            fish_id=None, quantity=None, gear_id=None,
                            idempotency_key=None):
        body = {"assetType": asset_type, "side": side,
                "limitUnitPrice": limit_unit_price}
        if fish_id:
            body["fishId"] = fish_id
        if quantity:
            body["quantity"] = quantity
        if gear_id:
            body["gearId"] = gear_id
        return self._post("/api/market/orders", body, idempotency_key)

    def market_purchase_order(self, order_id, idempotency_key=None):
        return self._post(f"/api/market/orders/{quote(order_id, safe='')}/purchase",
                          {}, idempotency_key)

    def market_cancel_order(self, order_id, idempotency_key=None):
        return self._post(f"/api/market/orders/{quote(order_id, safe='')}",
                          None, idempotency_key, method="DELETE")

    def market_order_book(self, fish_id):
        return self._get(f"/api/market/fish/{quote(fish_id, safe='')}/order-book")

    # ---- 背包 ----
    def inventory_fish(self, limit=100, cursor=None):
        return self._get("/api/inventory/fish", {
            "limit": limit, "cursor": cursor,
        })

    # ---- 钓鱼 / 游戏状态 ----
    def fishing_state(self):
        return self._get("/api/fishing/state")

    def biomes(self):
        return self._get("/api/biomes")

    def weather(self, biome_id):
        return self._get("/api/weather", {"biomeId": biome_id})

    # ---- 专精 / 鱼饵 ----
    def mastery(self):
        return self._get("/api/mastery")

    def mastery_talents(self):
        return self._get("/api/mastery/talents")

    def baits(self):
        return self._get("/api/baits")

    # ---- 背包 / 装备 ----
    def inventory_gear(self, slot=None, rarity=None, search=None, stat=None,
                       equipped=None, limit=20, cursor=None):
        return self._get("/api/inventory/gear", {
            "slot": slot, "rarity": rarity, "search": search, "stat": stat,
            "equipped": equipped, "limit": limit, "cursor": cursor,
        })

    # ---- 统计 / 公会 ----
    def statistics(self):
        return self._get("/api/statistics")

    def guilds_me(self):
        return self._get("/api/guilds/me")

    # ---- 原始路径 ----
    def raw(self, path):
        res = bridge.submit(path, timeout=self._timeout)
        return res


# ---------- CLI ----------

def _pp(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(description="通过浏览器扩展桥读取 reelax.cn 数据（只读）")
    p.add_argument("--timeout", type=int, default=20, help="等待扩展回传超时(秒)")
    p.add_argument("--bridge-port", type=int, default=BRIDGE_PORT,
                   help=f"桥端口（默认 {BRIDGE_PORT}；需与扩展设置一致）")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("me")
    sub.add_parser("market-config")
    sub.add_parser("market-fish-overview")
    sub.add_parser("fishing-state")
    sub.add_parser("biomes")
    sub.add_parser("mastery")
    sub.add_parser("mastery-talents")
    sub.add_parser("baits")
    sub.add_parser("statistics")
    sub.add_parser("guilds-me")
    sub.add_parser("inventory-fish")

    # ---- barter 只读 ----
    bo = sub.add_parser("barter-orders")
    bo.add_argument("--limit", type=int, default=24)
    bo.add_argument("--can-fulfill", dest="can_fulfill", default="true")
    bo.add_argument("--offers-mastery", dest="offers_mastery", default="true")
    bo.add_argument("--target-fish-id")
    bo.add_argument("--cursor")

    bmo = sub.add_parser("barter-my-orders")
    bmo.add_argument("--status", default="active")
    bmo.add_argument("--limit", type=int, default=24)

    bmt = sub.add_parser("barter-my-trades")
    bmt.add_argument("--limit", type=int, default=30)

    # ---- barter 写操作 ----
    bc = sub.add_parser("barter-create")
    bc.add_argument("--requests", required=True, help='JSON: [{"fishId":"b_x_yyy","quantity":1}]')
    bc.add_argument("--offers", required=True, help='JSON: [{"fishId":"b_x_yyy","quantity":1}]')

    bf = sub.add_parser("barter-fill")
    bf.add_argument("--order-id", required=True)
    bf.add_argument("--request-fish-id", required=True)
    bf.add_argument("--offer-fish-id", required=True)

    bx = sub.add_parser("barter-cancel")
    bx.add_argument("--order-id", required=True)

    mo = sub.add_parser("market-orders")
    mo.add_argument("--asset-type", default="gear")
    mo.add_argument("--side", default="sell")
    mo.add_argument("--rarities")
    mo.add_argument("--rarity")
    mo.add_argument("--min-price", type=int)
    mo.add_argument("--max-price", type=int)
    mo.add_argument("--slot")
    mo.add_argument("--stat")
    mo.add_argument("--min-quality", type=int)
    mo.add_argument("--min-upgrade", type=int)
    mo.add_argument("--sort", default="rarity")
    mo.add_argument("--direction", default="desc")
    mo.add_argument("--limit", type=int, default=20)
    mo.add_argument("--cursor")

    mm = sub.add_parser("market-my-orders")
    mm.add_argument("--asset-type")
    mm.add_argument("--limit", type=int, default=50)
    mm.add_argument("--cursor")

    mt = sub.add_parser("market-my-trades")
    mt.add_argument("--asset-type")
    mt.add_argument("--limit", type=int, default=50)
    mt.add_argument("--cursor")

    ig = sub.add_parser("inventory-gear")
    ig.add_argument("--slot")
    ig.add_argument("--rarity")
    ig.add_argument("--search")
    ig.add_argument("--stat")
    ig.add_argument("--equipped")
    ig.add_argument("--limit", type=int, default=20)
    ig.add_argument("--cursor")

    wt = sub.add_parser("weather")
    wt.add_argument("--biome", required=True)

    rw = sub.add_parser("raw")
    rw.add_argument("path")

    sub.add_parser("serve")

    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        sys.exit(1)

    if args.cmd == "serve":
        ws_bridge.start(port=args.bridge_port)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return

    api = ReelaxApi(timeout=args.timeout, port=args.bridge_port)
    if args.cmd == "me":
        _pp(api.me())
    elif args.cmd == "market-config":
        _pp(api.market_config())
    elif args.cmd == "market-fish-overview":
        _pp(api.market_fish_overview())
    elif args.cmd == "market-orders":
        _pp(api.market_orders(
            asset_type=args.asset_type, side=args.side,
            rarities=args.rarities, rarity=args.rarity,
            min_price=args.min_price, max_price=args.max_price,
            slot=args.slot, stat=args.stat,
            min_quality=args.min_quality, min_upgrade=args.min_upgrade,
            sort=args.sort, direction=args.direction,
            limit=args.limit, cursor=args.cursor,
        ))
    elif args.cmd == "market-my-orders":
        _pp(api.market_my_orders(args.asset_type, args.limit, args.cursor))
    elif args.cmd == "market-my-trades":
        _pp(api.market_my_trades(args.asset_type, args.limit, args.cursor))
    elif args.cmd == "fishing-state":
        _pp(api.fishing_state())
    elif args.cmd == "biomes":
        _pp(api.biomes())
    elif args.cmd == "weather":
        _pp(api.weather(args.biome))
    elif args.cmd == "mastery":
        _pp(api.mastery())
    elif args.cmd == "mastery-talents":
        _pp(api.mastery_talents())
    elif args.cmd == "baits":
        _pp(api.baits())
    elif args.cmd == "inventory-gear":
        _pp(api.inventory_gear(args.slot, args.rarity, args.search, args.stat,
                               args.equipped, args.limit, args.cursor))
    elif args.cmd == "statistics":
        _pp(api.statistics())
    elif args.cmd == "guilds-me":
        _pp(api.guilds_me())
    elif args.cmd == "inventory-fish":
        _pp(api.inventory_fish(args.limit if hasattr(args, "limit") else 100))
    elif args.cmd == "barter-orders":
        _pp(api.barter_orders(
            limit=args.limit,
            can_fulfill=args.can_fulfill.lower() == "true",
            offers_mastery=args.offers_mastery.lower() == "true",
            target_fish_id=args.target_fish_id,
            cursor=args.cursor))
    elif args.cmd == "barter-my-orders":
        _pp(api.barter_my_orders(status=args.status, limit=args.limit))
    elif args.cmd == "barter-my-trades":
        _pp(api.barter_my_trades(limit=args.limit))
    elif args.cmd == "barter-create":
        _pp(api.barter_create_order(
            requests=json.loads(args.requests),
            offers=json.loads(args.offers)))
    elif args.cmd == "barter-fill":
        _pp(api.barter_fill_order(
            order_id=args.order_id,
            request_fish_id=args.request_fish_id,
            offer_fish_id=args.offer_fish_id))
    elif args.cmd == "barter-cancel":
        _pp(api.barter_cancel_order(order_id=args.order_id))
    elif args.cmd == "raw":
        _pp(api.raw(args.path))


if __name__ == "__main__":
    main()
