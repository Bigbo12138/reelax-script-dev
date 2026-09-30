# mastery.py —— 专精目标提取（从 /api/mastery）
import logging

from . import config, pricing

log = logging.getLogger("market.mastery")

_RARITY_ORDER = ["arcane", "exotic", "mythic", "legendary", "epic",
                 "rare", "fine", "uncommon", "common"]


def _rarity_index(rarity):
    return _RARITY_ORDER.index(rarity) if rarity in _RARITY_ORDER else len(_RARITY_ORDER)


def extract_targets(mastery_data):
    """从 /api/mastery 响应提取未完成的专精鱼需求集。

    返回按（稀有度从高到低，剩余数从小到大）排序的列表：
    [{biomeId, biomeName, rarity, fishId, fishName,
      required, contributed, remaining, locked, xpBonusBasisPoints, directGoldBonusBasisPoints}]
    """
    targets = []
    for biome in mastery_data.get("biomes") or []:
        for r in biome.get("rarities") or []:
            if r.get("isFishLocked"):
                continue  # 前一档未完成，锁着交不了，跳过
            fish = r.get("fish") or {}
            remaining = (r.get("requiredQuantity") or 0) - (r.get("contributedQuantity") or 0)
            if remaining <= 0:
                continue  # 已完成
            targets.append({
                "biomeId": biome.get("biomeId"),
                "biomeName": biome.get("biomeName"),
                "rarity": r.get("rarity"),
                "fishId": fish.get("id"),
                "fishName": fish.get("name"),
                "required": r.get("requiredQuantity"),
                "contributed": r.get("contributedQuantity"),
                "remaining": remaining,
                "locked": False,
                "xpBonusBasisPoints": biome.get("xpBonusBasisPoints"),
                "directGoldBonusBasisPoints": biome.get("directGoldBonusBasisPoints"),
            })

    # 过滤配置里限定的稀有度
    allowed = config.BARTER_TARGET_RARITIES
    if allowed:
        targets = [t for t in targets if t["rarity"] in allowed]

    targets.sort(key=lambda t: (_rarity_index(t["rarity"]), t["remaining"]))
    return targets


def top_targets(mastery_data, limit=config.BARTER_MAX_TARGETS_PER_SCAN):
    """单轮扫描的目标鱼子集（控制请求量）。"""
    return extract_targets(mastery_data)[:limit]
