# alerts.py —— 企业微信 webhook 统一告警（含节流、订单去重、失败重试）
import json
import logging
import time
import urllib.request

from . import config, store

log = logging.getLogger("market.alerts")

# 企业微信错误码中这些需要人工处理，不做重试
_FATAL_CODES = {93000, 93001, 93002, 93003}


def _post_webhook(content, msgtype="markdown"):
    payload = {msgtype: {"content": content}}
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        config.WEBHOOK_URL, data=data,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body
    except Exception as e:  # 网络错误让上层重试
        raise RuntimeError(f"webhook 请求失败: {e}")


def send_alert(kind, title, content, dedup_order_id=None):
    """统一告警入口。

    - dedup_order_id 非空时按 order 去重（同订单只提醒一次）。
    - 按 kind 节流（config.ALERT_THROTTLE_MIN 分钟内同类只发一次）。
    - 失败退避重试 2 次；仍失败仅记日志，不抛给策略。
    """
    # 订单去重
    if dedup_order_id and not store.mark_order_seen(kind, dedup_order_id):
        log.info("[throttle] %s 订单已处理过: %s", kind, dedup_order_id)
        return False

    # 同类节流
    now = time.time()
    last = store.last_alert_ts(kind)
    if now - last < config.ALERT_THROTTLE_MIN * 60:
        log.info("[throttle] %s 距上次提醒 %.1f 分钟，跳过", kind, (now - last) / 60)
        return False

    body = f"**【{title}】**\n>{content}"
    for attempt in range(3):
        try:
            res = _post_webhook(body)
            if res.get("errcode") == 0:
                store.record_alert(kind)
                log.info("[alert] %s 已发送", kind)
                return True
            if res.get("errcode") in _FATAL_CODES:
                log.error("[alert] %s 企业微信致命错误: %s", kind, res)
                return False
            # 非致命错误码也要打出来，否则只看到「重试 3 次仍失败」无从排查
            log.warning("[alert] %s 企业微信返回 %s(第%d次)", kind, res, attempt + 1)
            time.sleep(2 * (attempt + 1))  # 退避
        except Exception as e:
            log.warning("[alert] %s 发送失败(第%d次): %s", kind, attempt + 1, e)
            time.sleep(2 * (attempt + 1))
    log.error("[alert] %s 重试 3 次仍失败，请检查 webhook 配置", kind)
    return False
