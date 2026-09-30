#!/usr/bin/env python3
# main.py —— 交易框架串行调度器（入口）
#
# 设计约束（见 量化交易框架设计.md §2/§4）：
#   - 单线程、绝不并发；API 节奏由 MarketApi.pace() 保证（基础间隔 + 随机抖动）。
#   - 三个市场模块按各自周期错峰运行（串行，同一时刻只跑一个）。
#   - 执行动作默认人工确认；auto 模式带全局冷却。
#   - 连续失败熔断：达到阈值暂停并告警，避免暴露 / 撞风控。
#
# 用法：
#   python3 -m market.main                            # 常驻调度（读 config.ENABLE_*）
#   python3 -m market.main --once                     # 跑一轮后退出
#   python3 -m market.main --dry-run --once           # 只读测试：不告警、不执行
#   python3 -m market.main --module barter --dry-run  # 单模块测试
#   python3 -m market.main --fill                     # 允许自动执行（还需 config.BARTER_FILL_MODE=auto）
import argparse
import logging
import signal
import sys
import time

from . import (alerts, barter_scanner, config, fish_market, gear_alert)
from .api_client import MarketApi

log = logging.getLogger("market.main")

# 模块注册表：name -> (module, 总开关, 周期分钟)
MODULES = {
    "barter": (barter_scanner, config.ENABLE_BARTER, config.BARTER_SCAN_INTERVAL_MIN),
    "fish": (fish_market, config.ENABLE_FISH_MARKET, config.FISH_MARKET_INTERVAL_MIN),
    "gear": (gear_alert, config.ENABLE_GEAR_ALERT, config.GEAR_ALERT_INTERVAL_MIN),
}

_TRADE_REFRESHERS = {
    "barter": barter_scanner.refresh_trades,
    "fish": fish_market.refresh_trades,
    "gear": gear_alert.refresh_trades,
}


def setup_logging(debug=False, logfile=None):
    handlers = [logging.StreamHandler(sys.stdout)]
    if logfile:
        handlers.append(logging.FileHandler(logfile, encoding="utf-8"))
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        handlers=handlers,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%H:%M:%S")


class Scheduler:
    """单线程串行调度器。

    - 模块按各自周期到点即跑；串行执行，绝不并发。
    - dry_run 时只读；fill 仅在 auto 模式 + 冷却到点 + 显式 --fill 时传给 barter。
    - 连续失败熔断：达到 FAILURE_CIRCUIT_MAX 暂停 CIRCUIT_PAUSE_SEC 并告警。
    """

    def __init__(self, api, dry_run=False, fill=False, modules=None):
        self.api = api
        self.dry_run = dry_run
        # 自动执行三重闸门：--fill + config.BARTER_FILL_MODE=auto + 冷却到点
        self.fill_enabled = fill and not dry_run and config.BARTER_FILL_MODE == "auto"
        self.modules = modules or [n for n in MODULES if MODULES[n][1]]
        self._stop = False
        self._last_run = {n: 0.0 for n in self.modules}
        self._last_trade_refresh = 0.0
        self._last_fill_ts = 0.0
        self._fail_streak = 0

    # ---- 基础设施 ----
    def _interruptible_sleep(self, sec):
        end = time.time() + sec
        while not self._stop and time.time() < end:
            time.sleep(min(0.5, end - time.time()))

    def _module_due(self, name):
        _mod, _enabled, interval_min = MODULES[name]
        return (time.time() - self._last_run[name]) >= interval_min * 60

    # ---- 模块执行 ----
    def _run_module(self, name, module, fn):
        try:
            kwargs = {"dry_run": self.dry_run,
                      "send_alerts": not self.dry_run}
            if name == "barter":
                kwargs["fill"] = self._should_fill()
            fn(self.api, **kwargs)
            self._fail_streak = 0
            if name == "barter" and kwargs["fill"]:
                self._last_fill_ts = time.time()
                log.info("[scheduler] 本轮已尝试自动填单，进入全局冷却")
        except Exception as e:
            self._fail_streak += 1
            log.error("[scheduler] %s 模块失败（连续 %d 次）: %s",
                      name, self._fail_streak, e)
            if not self.dry_run:   # dry-run 是只读自测，不该往群里发东西
                alerts.send_alert("error", "策略模块异常",
                                  f"**{name}** 运行失败\n>{e}")
            self._maybe_circuit_break()

    def _should_fill(self):
        if not self.fill_enabled:
            return False
        if time.time() - self._last_fill_ts < config.BARTER_FILL_COOLDOWN_MIN * 60:
            return False
        return True

    def _maybe_circuit_break(self):
        if self._fail_streak < config.FAILURE_CIRCUIT_MAX:
            return
        pause_min = int(config.CIRCUIT_PAUSE_SEC / 60)
        log.critical("[scheduler] 连续失败 %d 次，熔断暂停 %d 分钟",
                     self._fail_streak, pause_min)
        if not self.dry_run:
            alerts.send_alert("error", "调度器熔断",
                              f"连续失败 **{self._fail_streak}** 次，"
                              f"暂停 **{pause_min} 分钟**")
        self._interruptible_sleep(config.CIRCUIT_PAUSE_SEC)
        self._fail_streak = 0

    # ---- 成交增量入库（供参考价积累） ----
    def _refresh_trades_if_due(self):
        if time.time() - self._last_trade_refresh < config.TRADE_REFRESH_INTERVAL_MIN * 60:
            return
        self._last_trade_refresh = time.time()
        for name in self.modules:
            fn = _TRADE_REFRESHERS[name]
            try:
                fn(self.api)
            except Exception as e:
                log.warning("[scheduler] %s 成交刷新失败: %s", name, e)

    # ---- 主循环 ----
    def _tick(self):
        now = time.time()
        for name in self.modules:
            if now - self._last_run[name] >= MODULES[name][2] * 60:
                self._last_run[name] = now
                self._run_module(name, MODULES[name][0], MODULES[name][0].scan)
        self._refresh_trades_if_due()

    def run_once(self):
        log.info("[scheduler] 单轮执行，模块: %s", ", ".join(self.modules))
        self._tick()

    def run_forever(self):
        log.info("[scheduler] 启动，模块: %s | dry_run=%s | auto-fill=%s",
                 ", ".join(self.modules), self.dry_run, self.fill_enabled)
        while not self._stop:
            self._tick()
            self._interruptible_sleep(config.SCHEDULER_TICK_SEC)


def _install_signal_handlers(sched):
    def handler(signum, _frame):
        log.info("[scheduler] 收到信号 %s，优雅退出", signum)
        sched._stop = True
    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)


def main():
    p = argparse.ArgumentParser(description="Reelax 量化交易框架串行调度器")
    p.add_argument("--once", action="store_true", help="跑一轮后退出")
    p.add_argument("--dry-run", action="store_true", help="只读模式：不告警、不执行")
    p.add_argument("--fill", action="store_true",
                   help="允许自动执行（仍需 config.BARTER_FILL_MODE=auto，且有全局冷却）")
    p.add_argument("--module", choices=list(MODULES),
                   help="只跑指定模块（配合 --once / --dry-run 测试）")
    p.add_argument("--debug", action="store_true", help="DEBUG 级日志")
    p.add_argument("--logfile", help="同时写日志到文件")
    args = p.parse_args()

    setup_logging(debug=args.debug, logfile=args.logfile)

    if args.module:
        enabled = [args.module]
    else:
        enabled = [n for n in MODULES if MODULES[n][1]]
    if not enabled:
        log.warning("没有启用任何模块（config.ENABLE_* 全为 False，或用 --module 指定）")
        return

    api = MarketApi()
    sched = Scheduler(api, dry_run=args.dry_run, fill=args.fill, modules=enabled)
    _install_signal_handlers(sched)
    if args.once:
        sched.run_once()
    else:
        sched.run_forever()


if __name__ == "__main__":
    main()
