# pricing.py —— 统一价值/评分模型（市场价、NPC保底价、专精溢价）
import logging

from . import config

log = logging.getLogger("market.pricing")

# 稀有度档位，用于排序（0 最稀有）
_RARITY_RANK = {
    "arcane": 0, "exotic": 1, "mythic": 2, "legendary": 3,
    "epic": 4, "rare": 5, "fine": 6, "uncommon": 7, "common": 8,
}


def rarity_rank(rarity):
    return _RARITY_RANK.get(rarity, 99)


def fish_base_value(fish_id, overview_price, npc_sell_price):
    """基础价值 = max(最新成交价, NPC 保底价)。缺省用非 None 的那个，全缺省 0。"""
    candidates = [p for p in (overview_price, npc_sell_price) if p is not None]
    return max(candidates) if candidates else 0


def mastery_premium(base_value, remaining):
    """专精溢价：越接近完成（剩余需求越少）单价越值钱。

    溢价 = base_value × 系数 / max(1, remaining)，并封顶 base_value × cap。
    仅当 remaining > 0 时生效。
    """
    if remaining <= 0 or base_value <= 0:
        return 0
    raw = base_value * config.MASTERY_PREMIUM_COEFF / max(1, remaining)
    return min(raw, base_value * config.MASTERY_PREMIUM_CAP)


def fish_value(fish_id, overview_price, npc_sell_price, mastery_remaining=None):
    """鱼的统一价值 = 基础价值 + 专精溢价（若为目标鱼）。"""
    base = fish_base_value(fish_id, overview_price, npc_sell_price)
    premium = mastery_premium(base, mastery_remaining) if mastery_remaining else 0
    return base + premium


def barter_pair_score(give_value, take_value, give_inv_qty, keep_min=config.BARTER_KEEP_MIN):
    """barter 单笔（给出1条 requests 鱼，换 1 条 offers 鱼）评分。

    - 必须给出鱼库存过剩（quantity > keep_min）才会被考虑。
    - 评分 = 获得价值 - 给出价值（barter 无手续费，机会成本按基础价值计）。
    - 返回 None 表示不可执行（库存不足）。
    """
    if give_inv_qty <= keep_min:
        return None
    return take_value - give_value


def fish_sell_decision(market_price, npc_sell_price, fee_bps=config.MARKET_FEE_BPS):
    """鱼类市场卖出决策。

    返回 ("list", 税后净得) | ("npc", 净得) | (None, 0)
    """
    if not npc_sell_price:
        return (None, 0)
    net_list = int((market_price or 0) * (1 - fee_bps / 10000))
    if net_list > npc_sell_price:
        return ("list", net_list)
    return ("npc", npc_sell_price)


def fish_arb_net(market_price, buy_price, fee_bps=config.MARKET_FEE_BPS):
    """买入价 buy_price 的鱼，以 market_price 卖出后的税后净利。"""
    if not market_price or not buy_price:
        return 0
    return int(market_price * (1 - fee_bps / 10000)) - buy_price
