# api_client.py —— 交易框架数据层：封装 devtools/api.py，加节奏控制与幂等写操作
import logging
import random
import sys
import time
import uuid

from . import config

log = logging.getLogger("market.api")

# 加载 devtools/api.py（复用其桥 + 只读/写方法）
sys.path.insert(0, "/workspace/firefoxfish/devtools")
from api import ReelaxApi  # noqa: E402


class MarketApi:
    """带节奏控制的 API 封装。

    - 所有调用串行执行；每次调用后自动 sleep（只读 base+jitter，写操作更长）。
    - 写操作自动生成/复用 Idempotency-Key（同一 payload 复用同一 key，保证重试幂等）。
    """

    def __init__(self, timeout=25):
        self.api = ReelaxApi(timeout=timeout)
        self._last_payload_key = {}   # payload 签名 -> idempotencyKey

    # ---- 节奏 ----
    def pace(self, write=False):
        if write:
            time.sleep(config.WRITE_BASE_DELAY + random.random() * config.WRITE_JITTER_MAX)
        else:
            time.sleep(config.REQUEST_BASE_DELAY + random.random() * config.REQUEST_JITTER_MAX)

    # ---- 只读调用统一入口 ----
    def _read(self, fn, **kwargs):
        """只读调用：桥接超时视为瞬时故障，退避后重试一次。

        扩展侧偶尔会在某次 fetch 上卡住（页面重载、站点抖动），一次超时就让整轮
        策略失败太脆弱。写操作不走这里——超时后服务端状态未知，绝不能自动重试。
        每次尝试后都 pace()，保证重试也遵守请求节奏。
        """
        for attempt in range(2):
            try:
                return fn(**kwargs)
            except TimeoutError:
                if attempt:
                    raise
                log.warning("[api] %s 桥接超时，退避后重试一次", fn.__name__)
            finally:
                self.pace()

    # ---- 只读透传 ----
    def me(self):
        return self._read(self.api.me)

    def mastery(self):
        return self._read(self.api.mastery)

    def inventory_fish(self, limit=100):
        return self._read(self.api.inventory_fish, limit=limit)

    def market_config(self):
        return self._read(self.api.market_config)

    def market_fish_overview(self):
        return self._read(self.api.market_fish_overview)

    def market_orders(self, asset_type="gear", side=None, rarities=None, max_price=None,
                      min_price=None, slot=None, stat=None, min_quality=None,
                      min_upgrade=None, limit=20):
        return self._read(
            self.api.market_orders,
            asset_type=asset_type, side=side, rarities=rarities,
            max_price=max_price, min_price=min_price, slot=slot, stat=stat,
            min_quality=min_quality, min_upgrade=min_upgrade, limit=limit)

    def market_my_trades(self, asset_type=None, limit=50):
        return self._read(self.api.market_my_trades, asset_type=asset_type, limit=limit)

    def market_order_book(self, fish_id):
        return self._read(self.api.market_order_book, fish_id=fish_id)

    def barter_orders(self, can_fulfill=True, offers_mastery=True,
                      target_fish_id=None, limit=24):
        return self._read(
            self.api.barter_orders, limit=limit, can_fulfill=can_fulfill,
            offers_mastery=offers_mastery, target_fish_id=target_fish_id)

    def barter_my_orders(self, status="active", limit=24):
        return self._read(self.api.barter_my_orders, status=status, limit=limit)

    def barter_my_trades(self, limit=30):
        return self._read(self.api.barter_my_trades, limit=limit)

    # ---- 幂等 key ----
    def _idem_key(self, payload):
        sig = json_dumps(payload)
        if sig not in self._last_payload_key:
            self._last_payload_key[sig] = str(uuid.uuid4())
        return self._last_payload_key[sig]

    # ---- 写操作（返回原始 {status, ok, data, raw}） ----
    def barter_create_order(self, requests, offers):
        payload = {"requests": requests, "offers": offers}
        try:
            return self.api.barter_create_order(requests, offers,
                                                idempotency_key=self._idem_key(payload))
        finally:
            self.pace(write=True)

    def barter_fill_order(self, order_id, request_fish_id, offer_fish_id):
        payload = {"orderId": order_id, "requestFishId": request_fish_id,
                   "offerFishId": offer_fish_id}
        try:
            return self.api.barter_fill_order(order_id, request_fish_id, offer_fish_id,
                                              idempotency_key=self._idem_key(payload))
        finally:
            self.pace(write=True)

    def barter_cancel_order(self, order_id):
        payload = {"orderId": order_id}
        try:
            return self.api.barter_cancel_order(order_id,
                                                idempotency_key=self._idem_key(payload))
        finally:
            self.pace(write=True)

    def market_create_order(self, asset_type, side, limit_unit_price,
                            fish_id=None, quantity=None, gear_id=None):
        payload = {"assetType": asset_type, "side": side, "limitUnitPrice": limit_unit_price}
        if fish_id:
            payload["fishId"] = fish_id
        if quantity:
            payload["quantity"] = quantity
        if gear_id:
            payload["gearId"] = gear_id
        try:
            return self.api.market_create_order(
                asset_type, side, limit_unit_price,
                fish_id=fish_id, quantity=quantity, gear_id=gear_id,
                idempotency_key=self._idem_key(payload))
        finally:
            self.pace(write=True)

    def market_cancel_order(self, order_id):
        try:
            return self.api.market_cancel_order(order_id,
                                                idempotency_key=self._idem_key({"orderId": order_id}))
        finally:
            self.pace(write=True)

    def market_purchase_order(self, order_id):
        try:
            return self.api.market_purchase_order(order_id,
                                                  idempotency_key=self._idem_key({"orderId": order_id}))
        finally:
            self.pace(write=True)


def json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)
