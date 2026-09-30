# config.py —— 交易框架统一配置（所有策略参数集中在此，改这里即可）
#
# 书写约定（统一大小写，避免踩坑）：
#   - 布尔值一律用 Python 字面量 True / False（不是 true / false，写小写会 NameError）
#   - 空值一律用 None（不是 null）
#   - 字符串值一律小写，与服务端枚举保持一致（rarity / side / status 等都区分大小写，
#     大写会被 API 判为 VALIDATION_ERROR）
#   - 常量名一律全大写下划线风格
import os

# ---------------- 企业微信告警 ----------------
# 机器人 webhook 地址（完整 URL），所有提醒都发到这里。
# 从环境变量 FISH_WEBHOOK 获取（值=完整 URL）；未设置则为空（不告警）。
WEBHOOK_URL = os.environ.get("FISH_WEBHOOK", "").strip()
# 同一类告警（kind）的最小发送间隔（分钟），防刷屏。注意：订单类提醒另有按
# order_id 的永久去重（store.mark_order_seen），两层机制叠加生效。
ALERT_THROTTLE_MIN = 30

# ---------------- 请求节奏（风控核心：串行 + 间隔 + 抖动） ----------------
# 每次只读 API 调用「之后」固定等待的秒数。调小 = 扫得快但更像机器人。
REQUEST_BASE_DELAY = 2.5
# 在基础等待之上叠加的随机抖动上限（秒），实际等待 = BASE + random(0, JITTER)。
# 抖动的意义是让请求间隔不呈固定周期，避免被行为特征识别。
REQUEST_JITTER_MAX = 2.0
# 写操作（POST/DELETE：下单、填单、撤单）比只读敏感得多，单独给更长的间隔。
WRITE_BASE_DELAY = 4.0
WRITE_JITTER_MAX = 3.0

# ---------------- 总开关（决定 main.py 常驻调度时跑哪些模块） ----------------
# 注意：命令行 --module xxx 会无视这些开关强制单跑某模块（方便测试）。
ENABLE_BARTER = True          # 以物换物扫描
ENABLE_FISH_MARKET = False    # 鱼类市场（异动 / 卖出决策 / 套利提醒）
ENABLE_GEAR_ALERT = False     # 装备低价提醒

# ---------------- 以物换物（barter） ----------------
BARTER_SCAN_INTERVAL_MIN = 15    # 扫描周期（分钟），到点才跑一轮
BARTER_OFFERS_MASTERY = True     # True=只看「提供的鱼里有我专精目标」的单；False=看全部
BARTER_MIN_SCORE = 0             # 评分阈值，只有 score > 此值才算好单（评分=获得价值-给出价值）
BARTER_KEEP_MIN = 3              # 给出鱼的库存保留下限：库存 <= 此值就不给出，防止把口粮换掉
BARTER_FILL_MODE = "manual"      # "manual"=只提醒不动手 | "auto"=允许自动填单（还需命令行 --fill）
BARTER_TARGET_RARITIES = None    # 只盯这些稀有度的专精目标；None=全部
                                 # 可选值（小写）：["arcane","exotic","mythic","legendary",...]
BARTER_MAX_TARGETS_PER_SCAN = 6  # 单轮最多扫几个专精目标鱼（每个目标 1 次请求，直接决定请求量）
BARTER_PAGE_SIZE = 24            # 每个目标拉取多少条公开订单

# ---------------- 鱼类市场 ----------------
FISH_MARKET_INTERVAL_MIN = 30              # 扫描周期（分钟）
FISH_MARKET_MIN_ARB_PROFIT = 5000          # 套利候选的最低税后净利（金币），低于此不提醒
FISH_MARKET_PRICE_CHANGE_ALERT_BPS = 2000  # 24h 涨跌幅提醒阈值，单位基点（2000 = 20%）

# ---------------- 交易税 ----------------
# 市场成交手续费，单位基点（500 = 5%）。用于「挂市场 vs 卖 NPC」和套利净利的税后折算。
MARKET_FEE_BPS = 500

# ---------------- 装备市场（只做低价提醒，不自动买入） ----------------
GEAR_ALERT_INTERVAL_MIN = 45                   # 扫描周期（分钟）
GEAR_ALERT_RARITIES = ["legendary", "mythic"]  # 只扫这些稀有度的卖单（值必须小写）
GEAR_ALERT_MAX_PRICE = 200000                  # 只拉挂单价低于此值的装备（服务端过滤，省请求）
GEAR_ALERT_DISCOUNT_RATIO = 0.6                # 低估阈值：1 - 挂单价/参考价 >= 0.6 才提醒
GEAR_ALERT_PAGE_SIZE = 20                      # 每轮拉取的装备卖单数
GEAR_REF_PRICE_FALLBACK = 200000               # 该档位无历史成交时使用的兜底参考价
GEAR_REF_LOOKBACK_HOURS = 168                  # 参考价只统计最近 N 小时成交（7 天，防老价格拖偏）
GEAR_REF_MIN_SAMPLES = 3                       # 同档位至少 N 笔成交才用中位数，否则回退兜底价

# ---------------- 专精溢价系数 ----------------
# 专精目标鱼比市价更值钱。溢价 = 基础价 × COEFF / max(1, 剩余需求数)，
# 即越接近收集完成，单条越值钱；再按 CAP 封顶，避免只差 1 条时溢价爆炸。
MASTERY_PREMIUM_COEFF = 1.0
MASTERY_PREMIUM_CAP = 2.0       # 溢价不超过基础价的 2 倍

# ---------------- 调度器（main.py） ----------------
SCHEDULER_TICK_SEC = 15         # 主循环心跳（秒）：每隔这么久检查一次各模块是否到点
TRADE_REFRESH_INTERVAL_MIN = 60 # 我的成交记录增量入库周期（分钟），用于积累参考价
FAILURE_CIRCUIT_MAX = 5         # 熔断阈值：连续失败这么多次就停手（成功一次即清零）
CIRCUIT_PAUSE_SEC = 1800        # 熔断后暂停多久（秒），期间不发任何请求
BARTER_FILL_COOLDOWN_MIN = 60   # 自动填单的全局冷却（分钟），一轮最多填一单且需过冷却

# ---------------- 存储 ----------------
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trading.db")
