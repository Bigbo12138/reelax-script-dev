# store.py —— SQLite 落盘：订单去重 / 价格历史 / 成交记录
import json
import sqlite3
import threading
import time

from . import config

_lock = threading.Lock()


def _conn():
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db():
    with _lock, _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS seen_orders (
                kind TEXT NOT NULL,
                order_id TEXT NOT NULL,
                seen_at INTEGER NOT NULL,
                extra TEXT,
                PRIMARY KEY (kind, order_id)
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS fish_prices (
                fish_id TEXT NOT NULL,
                ts INTEGER NOT NULL,
                price INTEGER,
                source TEXT
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                kind TEXT NOT NULL,
                trade_id TEXT NOT NULL,
                ts INTEGER NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY (kind, trade_id)
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS alert_log (
                kind TEXT NOT NULL,
                sent_at INTEGER NOT NULL
            )""")
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_fish_prices
            ON fish_prices (fish_id, ts)""")
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_trades_ts
            ON trades (kind, ts)""")


def mark_order_seen(kind, order_id, extra=None) -> bool:
    """记录一条已处理订单。返回 True 表示首次见到（可发提醒），False 表示已处理过。"""
    with _lock, _conn() as conn:
        cur = conn.execute(
            "SELECT 1 FROM seen_orders WHERE kind=? AND order_id=?",
            (kind, order_id))
        if cur.fetchone():
            return False
        conn.execute(
            "INSERT OR IGNORE INTO seen_orders (kind, order_id, seen_at, extra) VALUES (?,?,?,?)",
            (kind, order_id, int(time.time()), json.dumps(extra, ensure_ascii=False) if extra else None))
        return True


def last_alert_ts(kind) -> float:
    with _lock, _conn() as conn:
        cur = conn.execute(
            "SELECT MAX(sent_at) FROM alert_log WHERE kind=?", (kind,))
        row = cur.fetchone()
        return float(row[0]) if row and row[0] else 0.0


def record_alert(kind, sent_at=None):
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO alert_log (kind, sent_at) VALUES (?,?)",
            (kind, int(sent_at if sent_at else time.time())))


def save_fish_price(fish_id, price, source):
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO fish_prices (fish_id, ts, price, source) VALUES (?,?,?,?)",
            (fish_id, int(time.time()), price, source))


def fish_price_median(fish_id, lookback_hours=72) -> int | None:
    """近 N 小时价格中位数，用作参考价。"""
    cutoff = int(time.time()) - lookback_hours * 3600
    with _lock, _conn() as conn:
        rows = conn.execute(
            "SELECT price FROM fish_prices WHERE fish_id=? AND ts>=? AND price IS NOT NULL",
            (fish_id, cutoff)).fetchall()
    prices = sorted(r[0] for r in rows)
    if not prices:
        return None
    n = len(prices)
    return prices[n // 2]


def upsert_trade(kind, trade_id, ts, data) -> bool:
    """写入一条成交记录，返回 True 表示是新记录。"""
    with _lock, _conn() as conn:
        cur = conn.execute(
            "SELECT 1 FROM trades WHERE kind=? AND trade_id=?", (kind, trade_id))
        if cur.fetchone():
            return False
        conn.execute(
            "INSERT OR IGNORE INTO trades (kind, trade_id, ts, data) VALUES (?,?,?,?)",
            (kind, trade_id, int(ts), json.dumps(data, ensure_ascii=False)))
        return True


def trade_stats(kind):
    """成交记录统计：总笔数、按资产类型分组条数。"""
    with _lock, _conn() as conn:
        cur = conn.execute(
            "SELECT COUNT(*) FROM trades WHERE kind=?", (kind,))
        total = cur.fetchone()[0]
    return {"kind": kind, "total": total}


def recent_trades(kind, limit=100):
    """返回最近 N 条成交记录 [(ts, data_dict), ...]，按时间倒序。

    用于构建参考价（如装备按 rarity+slot 档位的历史成交中位数）。
    """
    with _lock, _conn() as conn:
        rows = conn.execute(
            "SELECT ts, data FROM trades WHERE kind=? ORDER BY ts DESC LIMIT ?",
            (kind, limit)).fetchall()
    return [(r[0], json.loads(r[1])) for r in rows]


init_db()
