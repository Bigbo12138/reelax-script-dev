# executor.py —— 执行层：默认人工确认模式，不自动发写请求
import logging

from . import api_client, config

log = logging.getLogger("market.executor")


class Executor:
    """写操作执行器。

    - config.BARTER_FILL_MODE == "auto" 且 force=False 时直接执行；
    - 默认 manual：dry_run 返回执行计划（payload 等），不发请求；
    - 测试/人工确认场景传 force=True 才会真正 POST/DELETE。
    """

    def __init__(self, api: api_client.MarketApi, fill_mode=None, force=False):
        self.api = api
        self.fill_mode = fill_mode or config.BARTER_FILL_MODE
        self.force = force

    def fill_barter(self, order, request_fish_id, offer_fish_id):
        plan = {
            "action": "barter_fill",
            "order_id": order.get("id"),
            "owner": order.get("ownerNickname"),
            "give": _fish_name(order, request_fish_id),
            "take": _fish_name(order, offer_fish_id),
        }
        if self.fill_mode == "auto" or self.force:
            res = self.api.barter_fill_order(
                order.get("id"), request_fish_id, offer_fish_id)
            plan["status"] = res.get("status")
            plan["ok"] = res.get("ok")
            plan["data"] = res.get("data")
            log.info("[executor] fill %s -> %s", plan["status"], res.get("raw", "")[:200])
            return plan
        plan["mode"] = "dry_run（manual 模式，未发请求）"
        log.info("[executor] manual 模式，跳过填单: %s", plan)
        return plan

    def cancel_barter(self, order_id):
        plan = {"action": "barter_cancel", "order_id": order_id}
        if self.force:
            res = self.api.barter_cancel_order(order_id)
            plan["status"] = res.get("status")
            plan["ok"] = res.get("ok")
            plan["data"] = res.get("data")
            return plan
        plan["mode"] = "dry_run（manual 模式，未发请求）"
        return plan


def _fish_name(order, fish_id):
    for k in ("requests", "offers"):
        for item in order.get(k) or []:
            if item.get("fish", {}).get("fishId") == fish_id:
                return item["fish"].get("name", fish_id)
    return fish_id
