# Reelax API 文档 🍊

维护说明：本文件由 `static.reelax.cn/assets/index-*.js`（线上前端打包）逆向提取。
签名规则、字段以实际抓包 / 逆向为准，发现变化请更新本条并注明日期。

来源 bundle：`index-DuXJnYwp.js`（2026-08-16 重新抓取比对，对应前端 v0.18.1「奥术献祭奖励与市场便利更新」，
较旧版 `BH2ElfCZ.js` 增补**市场实时订阅（SSE）端点** `/api/market/fish/events`、`/api/market/gear/events`（**免签**，
官方 script-api 的 `game.market.subscribeFish/subscribeGear` 底层），并新增 `/api/fishing/{id}` 单批详情）。
前端会随发版重命名 hash，重新抓取命令见末尾「如何更新本文件」。

> **2026-08-13 比对新增**（相对旧版 doc，去噪后）：`/api/chests/{id}/open|purchase`、
> `/api/inventory/items/{id}/open`（开道具盒/遗物碎片礼盒）、`/api/market/items/{id}/order-book`、
> `/api/biomes/{id}/unlock`、`/api/mastery/{id}/contribute-all`（monitor.js 已用）、
> `/api/gear/{id}/*`、`/api/rods/{id}/*`、`/api/baits/{id}/equip|purchase` 等子资源动作，
> 详见各分组 ★/？ 标注。注：旧 doc 把 `/api/gear`、`/api/rods` 等 umbrella 压成单行，新 bundle 拆出了具体动作。

## 图例

- **签名**：取值 `免签` / `需签` / `未知`。
  - `免签` = 不需 `x-arcane-request-*` 签名头即可调用（已知白名单，见下）。
  - `需签` = 必须带短时请求签名（HMAC-SHA256 over `v1\nMETHOD\npath\nms\ntimestamp\nbody`，见 SKILL.md §2.5）。
  - `未知` = 未证实是否免签，默认按 `需签` 处理最稳妥。
- `{id}` / `{publicId}` 等表示路径参数（具体参数名以后端为准，本文按 bundle 字面写法保留）。
- 说明列里的「★」= 我们的工具已封装调用；「？」= 用途为逆向猜测，待验证。

## 免签白名单（已确认）

| 端点 | 作用 |
|---|---|
| `/api/me` | 取自身信息，**同时下发 `x-arcane-request-proof`**，用于引导后续签名 |
| `/api/auth/login` | 登录 |
| `/api/auth/register` | 注册 |
| `/api/content/bootstrap` | 首屏内容引导（免签） |
| `/api/meta/frontend-release` | 前端版本 / 更新公告（驱动更新弹窗） |
| `/api/market/fish/events` | **市场鱼实时订阅（认证 SSE）**，免签（`game.market.subscribeFish` 底层）|
| `/api/market/gear/events` | **市场装备实时订阅（认证 SSE）**，免签（`game.market.subscribeGear` 底层）|
| `/api/integrations/afdian/webhook` | 爱发电服务器回调（**POST** 入站 webhook，非前端调用，仅签名白名单放行）|

> 其余端点默认 `需签`。`/api/auth/logout` 等未列入白名单，标注为「未知 / 默认需签」。

---

## 1. 账户与认证

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/account` | 需签 | 账户信息 |
| `/api/account/password` | 需签 | 改密码 |
| `/api/auth/login` | **免签** | 登录 |
| `/api/auth/register` | **免签** | 注册 |
| `/api/auth/logout` | 未知(疑免签) | 登出 |

## 2. 元信息 / 引导

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/content/bootstrap` | **免签** | 首屏内容 |
| `/api/meta/frontend-release` | **免签** | 前端版本+更新公告 ★（详情见文末） |

## 3. 玩家自身

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/me` | **免签** | 自身信息 ★ |
| `/api/player/current-biome` | 需签 | 当前所在图 ★（聚合.js 用） |
| `/api/player/equipped-title` | 需签 | 已装备称号 |
| `/api/player/gold-penalty/acknowledge` | 需签 | 金币惩罚已读确认 |
| `/api/player/stats/allocate` | 需签 | 加点 ★（monitor.js 用） |
| `/api/player/stats/reset` | 需签 | 重置加点 |
| `/api/player/titles` | 需签 | 称号列表 |

## 4. 玩家档案 / 社交展示

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/player-profile/avatar` | 需签 | 头像 |
| `/api/player-profile/fish-showcase` | 需签 | 鱼展示 |
| `/api/player-profile/name-style` | 需签 | 名字样式 |
| `/api/player-profile/nickname` | 需签 | 昵称 |
| `/api/player-profile/achievement-showcase` | 需签 | 成就展示 |
| `/api/player-profile/settings` | 需签 | 档案设置 |

## 5. 钓鱼核心

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/fishing/state` | 需签 | 钓鱼批状态 ★ |
| `/api/fishing/start` | 需签 | 开始批次 ？ |
| `/api/fishing/stop` | 需签 | 停止批次 ？ |
| `/api/fishing/refill` | 需签 | 补满杆数 ★ |
| `/api/fishing/sync` | 需签 | 心跳同步（monitor 监听） |
| `/api/fishing/custom-statistics/{id}` | 需签 | 自定义统计 ？ |
| `/api/fishing/custom-statistics/history` | 需签 | 自定义统计历史 |
| `/api/fishing/global-notifications/history` | 需签 | 全服通知历史 |
| `/api/fishing/{id}` | 需签 | 单钓鱼批次详情（v0.18.1 新增，`game.fishing` 相关）|

## 6. 地图 / 天气

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/biomes` | 需签 | 所有地图 ★ |
| `/api/biomes/{id}` | 需签 | 单图详情 |
| `/api/weather?biomeId=` | 需签 | 天气 ★ |
| `/api/biomes/{id}/unlock` | 需签 | 解锁地图（等级达槛可解锁 b_010+）？ |

## 7. 专精 / 鱼饵 / 鱼竿

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/mastery` | 需签 | 专精链 ★ |
| `/api/mastery/{id}` | 需签 | 单图专精 |
| `/api/mastery/talents` | 需签 | 专精天赋 ★ |
| `/api/mastery/talents/{id}` | 需签 | 单天赋 |
| `/api/mastery/talents/reset` | 需签 | 重置专精天赋 ？ |
| `/api/mastery/talents/{id}/upgrade` | 需签 | 升级单天赋 ？ |
| `/api/mastery/{id}/contribute-all` | 需签 | 单图专精一键贡献 ★（monitor.js 自动加专精） |
| `/api/mastery/{id}/requirements/{id}/contribute` | 需签 | 专精需求贡献 ？ |
| `/api/baits` | 需签 | 鱼饵列表 ★ |
| `/api/baits/{id}` | 需签 | 单鱼饵（含 `/equip` 装备）★ |
| `/api/baits/{id}/equip` | 需签 | 装备鱼饵 ★ |
| `/api/baits/{id}/purchase` | 需签 | 购买鱼饵 ？ |
| `/api/baits/auto-refill` | 需签 | 鱼饵自动补 ？ |
| `/api/rods` | 需签 | 鱼竿列表 ？ |
| `/api/rods/{id}` | 需签 | 单鱼竿（升级/装备）？ |
| `/api/rods/{id}/equip` | 需签 | 装备鱼竿 ？ |
| `/api/rods/{id}/purchase` | 需签 | 购买鱼竿 ？ |
| `/api/rods/{id}/upgrade` | 需签 | 升级鱼竿 ？ |
| `/api/rods/{id}/reset` | 需签 | 重置鱼竿 ？ |

## 8. 背包 / 库存

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/inventory/fish` | 需签 | 鱼库存 ★ |
| `/api/inventory/fish/{id}` | 需签 | 单鱼 |
| `/api/inventory/fish/sell` | 需签 | 卖鱼（可替代 DOM 自动出售）|
| `/api/inventory/fish/{id}/lock` | 需签 | 锁定单条鱼 ？ |
| `/api/inventory/fish/{id}/titan-values` | 需签 | 鱼的天价估值（titan 级定价）？ |
| `/api/inventory/fish/settings` | 需签 | 鱼库存设置 ？ |
| `/api/inventory/gear` | 需签 | 装备库存 ★ |
| `/api/inventory/gear/sell` | 需签 | 卖装备 |
| `/api/inventory/gear/sale-preview` | 需签 | 出售预览估价 |
| `/api/inventory/chests` | 需签 | 宝箱库存 |
| `/api/inventory/items` | 需签 | 道具库存 |
| `/api/inventory/items/{id}` | 需签 | 单道具 |
| `/api/inventory/items/{id}/open` | 需签 | 开启道具盒（如遗物碎片礼盒，含 `openReward`）★（对应物品市场买的礼盒） |
| `/api/chests/{id}` | 需签 | 宝箱（umbrella）？ |
| `/api/chests/{id}/purchase` | 需签 | 购买宝箱 ★（open_chests.py 用） |
| `/api/chests/{id}/open` | 需签 | 开启宝箱 ★（open_chests.py 用） |

## 9. 市场（鱼 / 装备）

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/market/config` | 需签 | 市场配置 ★ |
| `/api/market/orders` | 需签 | 订单查询/挂单 ★ |
| `/api/market/orders/{id}` | 需签 | 单订单 |
| `/api/market/orders/{id}/purchase` | 需签 | 购买 |
| `/api/market/fish/overview` | 需签 | 鱼行情总览 ★ |
| `/api/market/fish/{id}` | 需签 | 单鱼行情 ？ |
| `/api/market/fish/{id}/order-book` | 需签 | 鱼订单簿 ★ |
| `/api/market/items/{id}` | 需签 | 单物品行情 ？ |
| `/api/market/me/orders` | 需签 | 我的挂单 ★ |
| `/api/market/me/trades` | 需签 | 我的成交 ★ |
| `/api/market/items/{id}/order-book` | 需签 | 物品订单簿 ？（item 市场深度，含遗物礼盒） |
| `/api/market/me/fish-holdings` | 需签 | 我的鱼持仓 ？ |
| `/api/market/me/state` | 需签 | 我的市场状态 ？ |
| `/api/market/fish/events` | **免签** | 市场鱼实时订阅（**认证 SSE**，`game.market.subscribeFish` 底层）。v0.18.1 新增 |
| `/api/market/gear/events` | **免签** | 市场装备实时订阅（**认证 SSE**，`game.market.subscribeGear` 底层）。v0.18.1 新增 |

## 10. 以物换物（barter）

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/barter/orders` | 需签 | 公开订单/创建 ★ |
| `/api/barter/orders/{id}` | 需签 | 单订单 |
| `/api/barter/orders/{id}/fill` | 需签 | 填单 |
| `/api/barter/me/orders` | 需签 | 我的挂单 ★ |
| `/api/barter/me/trades` | 需签 | 我的成交 ★ |

## 11. 商店 / 兑换 / 便利

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/shop` | 需签 | 商店首页 ？ |
| `/api/shop/exchange-quote` | 需签 | 兑换估价 ？ |
| `/api/shop/exchanges` | 需签 | 兑换执行 ？ |
| `/api/shop/purchases` | 需签 | 购买记录 ？ |
| `/api/convenience` | 需签 | 便利功能 ？ |
| `/api/convenience/purchases` | 需签 | 便利购买 ？ |
| `/api/convenience/route-assistant/enabled` | 需签 | 路线助手开关 ？ |
| `/api/convenience/route-assistant/settings` | 需签 | 路线助手设置 ？ |

## 12. 成就 / 签到 / 任务

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/achievements` | 需签 | 成就列表 |
| `/api/achievements/{id}` | 需签 | 单成就 |
| `/api/achievements/claim-all` | 需签 | 一键领取成就奖励 |
| `/api/achievements/{id}/claim` | 需签 | 领取单成就奖励 ？ |
| `/api/daily-check-in` | 需签 | 签到状态 |
| `/api/daily-check-in/claim` | 需签 | 签到领取 ★（官方 API）|
| `/api/daily-check-in/leaderboard` | 需签 | 签到榜 |
| `/api/quests` | 需签 | 任务列表（全新，可能可自动化）|
| `/api/quests/{id}` | 需签 | 单任务 |
| `/api/quests/{id}/reroll` | 需签 | 重 roll 单任务 ？ |

## 13. 公会

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/guilds` | 需签 | 公会列表/创建 ？ |
| `/api/guilds/{id}` | 需签 | 单公会 |
| `/api/guilds/{id}/members` | 需签 | 公会成员（公开侧）？ |
| `/api/guilds/{id}/tournament-history` | 需签 | 公会赛历史 ？ |
| `/api/guilds/{id}/trophies` | 需签 | 公会赛奖杯 ？ |
| `/api/guilds/search` | 需签 | 公会搜索 |
| `/api/guilds/rankings` | 需签 | 公会排行 |
| `/api/guilds/me` | 需签 | 我的公会 ★ |
| `/api/guilds/me/activities` | 需签 | 公会活动 |
| `/api/guilds/me/applications` | 需签 | 入会申请 |
| `/api/guilds/me/applications/{id}` | 需签 | 单申请 |
| `/api/guilds/me/applications/{id}/approve` | 需签 | 批准入会申请 ？ |
| `/api/guilds/me/applications/{id}/reject` | 需签 | 拒绝入会申请 ？ |
| `/api/guilds/me/boosts` | 需签 | 公会加成 |
| `/api/guilds/me/boosts/{id}` | 需签 | 单加成 |
| `/api/guilds/me/disband` | 需签 | 解散公会 |
| `/api/guilds/me/donations` | 需签 | 公会捐赠 |
| `/api/guilds/me/identity` | 需签 | 公会身份 ？ |
| `/api/guilds/me/leave` | 需签 | 退出公会 |
| `/api/guilds/me/members/{id?}` | 需签 | 成员 |
| `/api/guilds/me/members/{id}/role` | 需签 | 设置成员角色 ？ |
| `/api/guilds/me/name-style` | 需签 | 公会名样式 |
| `/api/guilds/me/settings` | 需签 | 公会设置 |
| `/api/guilds/me/totems` | 需签 | 图腾 |
| `/api/guilds/me/totems/{id}` | 需签 | 单图腾 |
| `/api/guilds/me/totems/{id}/upgrade` | 需签 | 升级图腾 ？ |
| `/api/guilds/me/transfer-leadership` | 需签 | 转让会长 |
| `/api/guilds/me/treasury` | 需签 | 公会金库 |
| `/api/guilds/applications/{id?}` | 需签 | 申请（公开侧）|

## 14. 组队船（party-boats，跟随船底层）

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/party-boats/crowdfundings` | 需签 | 众筹列表 |
| `/api/party-boats/crowdfundings/{id}` | 需签 | 单众筹 |
| `/api/party-boats/crowdfundings/current` | 需签 | 当前众筹 |
| `/api/party-boats/crowdfundings/current/cancel` | 需签 | 取消众筹 |
| `/api/party-boats/crowdfundings/current/disband-vote` | 需签 | 解散投票 |
| `/api/party-boats/crowdfundings/current/upgrade` | 需签 | 升级众筹 |
| `/api/party-boats/crowdfundings/join-by-code` | 需签 | 凭码加入众筹 |
| `/api/party-boats/crowdfundings/{id}/join` | 需签 | 加入指定众筹 ？ |
| `/api/party-boats/crowdfundings/preview-code` | 需签 | 预览邀请码 |
| `/api/party-boats/crowdfundings/public` | 需签 | 公开众筹 |
| `/api/party-boats/current-biome` | 需签 | 船当前图（跟随船）|
| `/api/party-boats/disband` | 需签 | 解散船 |
| `/api/party-boats/invitations` | 需签 | 邀请列表 |
| `/api/party-boats/invitations/{id}` | 需签 | 单邀请 |
| `/api/party-boats/invitations/{id}/accept` | 需签 | 接受邀请 ？ |
| `/api/party-boats/invitations/{id}/cancel` | 需签 | 取消邀请 ？ |
| `/api/party-boats/invitations/{id}/reject` | 需签 | 拒绝邀请 ？ |
| `/api/party-boats/join-by-code` | 需签 | 凭码上船 |
| `/api/party-boats/join-code/rotate` | 需签 | 刷新上船码 |
| `/api/party-boats/launch` | 需签 | 发船 |
| `/api/party-boats/leave` | 需签 | 下船 |
| `/api/party-boats/members/{id?}` | 需签 | 船员 |
| `/api/party-boats/members/{id}/remove` | 需签 | 移除船员 ？ |
| `/api/party-boats/members/{id}/role` | 需签 | 设置船员角色 ？ |
| `/api/party-boats/name` | 需签 | 船名 |
| `/api/party-boats/overview` | 需签 | 船总览 |
| `/api/party-boats/player-search` | 需签 | 玩家搜索（邀人）|
| `/api/party-boats/public` | 需签 | 公开船列表 |
| `/api/party-boats/public/{id}` | 需签 | 单公开船 |
| `/api/party-boats/public/{id}/join` | 需签 | 加入公开船 ？ |
| `/api/party-boats/purchase` | 需签 | 购船 |
| `/api/party-boats/recycle` | 需签 | 回收船 |
| `/api/party-boats/rent` | 需签 | 租船 |
| `/api/party-boats/rental/end` | 需签 | 结束租赁 |
| `/api/party-boats/rental/extend` | 需签 | 续租 |
| `/api/party-boats/rental/buyout` | 需签 | 买断租赁 ？ |
| `/api/party-boats/treasury` | 需签 | 船金库 |
| `/api/party-boats/treasury/deposit` | 需签 | 船金库存币 |
| `/api/party-boats/upkeep` | 需签 | 船保养 |
| `/api/party-boats/visibility` | 需签 | 船可见性 |

## 15. 赛事 / 锦标赛

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/tournaments/{id?}` | 需签 | 赛事 |
| `/api/tournaments/overview` | 需签 | 赛事总览 |
| `/api/tournaments/archive` | 需签 | 赛事归档 |
| `/api/tournaments/history` | 需签 | 赛事历史 |
| `/api/tournaments/medals` | 需签 | 奖牌 |
| `/api/tournaments/register-all` | 需签 | 一键报名 |
| `/api/tournaments/{id}/register` | 需签 | 报名单赛事 ？ |
| `/api/tournaments/{id}/leaderboard` | 需签 | 单赛事排行榜 ？ |
| `/api/weekly-tournaments/history` | 需签 | 周赛历史 |
| `/api/weekly-tournaments/medals` | 需签 | 周赛奖牌 |
| `/api/weekly-tournaments/overview` | 需签 | 周赛总览 |
| `/api/guild-tournaments/overview` | 需签 | 公会赛总览 |
| `/api/guild-tournaments/history` | 需签 | 公会赛历史 |
| `/api/guild-tournaments/trophies` | 需签 | 公会赛奖杯 |
| `/api/guild-tournaments/{id}/register` | 需签 | 公会赛报名 ？ |
| `/api/guild-tournaments/{id}/leaderboard` | 需签 | 公会赛排行榜 ？ |
| `/api/guild-tournaments/{id}/contributions` | 需签 | 公会赛贡献 ？ |

## 16. 活动 / 赞助 / 兑换码

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/events/arcane-sacrifice` | 需签 | 奥术献祭活动 |
| `/api/events/arcane-sacrifice/contributions` | 需签 | 贡献列表 |
| `/api/events/arcane-sacrifice/current-leaderboard` | 需签 | 当前排行榜 |
| `/api/events/arcane-sacrifice/leaderboard` | 需签 | 排行榜 |
| `/api/events/arcane-sacrifice/rewards` | 需签 | 奖励列表 |
| `/api/events/arcane-sacrifice/rewards/{id}` | 需签 | 单奖励领取 |
| `/api/events/arcane-sacrifice/rewards/{id}/participants` | 需签 | 献祭奖励参与名单 ？ |
| `/api/sponsorship/cdks/redeem-batch` | 需签 | 批量兑换 CDK |
| `/api/sponsorship/credits` | 需签 | 赞助积分 |
| `/api/sponsorship/me` | 需签 | 我的赞助 |

## 17. 排行榜 / 社区 / 图鉴

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/leaderboards` | 需签 | 排行榜 |
| `/api/leaderboards/dates` | 需签 | 排行榜日期 |
| `/api/players/{publicId}` | 需签 | 玩家公开档案 |
| `/api/players/{id}/statistics` | 需签 | 玩家公开统计 ？ |
| `/api/fishpedia` | 需签 | 鱼类图鉴 |

## 18. 统计 / 装备配装 / 管理

| 端点 | 签名 | 说明 |
|---|---|---|
| `/api/statistics` | 需签 | 统计 ★ |
| `/api/gear/loadouts` | 需签 | 装备配装列表 |
| `/api/gear/loadouts/{id}` | 需签 | 单配装 |
| `/api/gear/loadouts/{id}/load` | 需签 | 应用配装 ？ |
| `/api/gear/{id}/equip` | 需签 | 装备单件 ？ |
| `/api/gear/{id}/unequip` | 需签 | 卸下装备 ？ |
| `/api/gear/{id}/lock` | 需签 | 锁定装备 ？ |
| `/api/gear/{id}/reforge` | 需签 | 重铸装备 ？ |
| `/api/gear/{id}/upgrade` | 需签 | 升级装备 ？（跨档强化链路）|
| `/api/admin/{path}` | 未知 | 管理后台（非玩家用）|

---

# 端点详情（模板 + 已填）

> 下面按「一个端点一份详情」格式写。先填了已确认字段的 `/api/meta/frontend-release` 作模板，
> 其余端点按此格式逐步补全（方法/请求体/响应字段以抓包或 bundle 逆向补齐，标注 `?` 的待验证）。

## `/api/meta/frontend-release` —— 前端版本与更新公告

- **方法**：`GET`
- **签名**：**免签**（白名单）
- **认证**：无需登录
- **路径/查询参数**：无
- **请求体**：无
- **响应体**（`application/json`）：

  | 字段 | 类型 | 说明 |
  |---|---|---|
  | `latestVersion` | string | 最新前端版本号（如 `"0.17.3"`）|
  | `updatePolicy` | string | `optional`=可关弹窗；`required`/`forced`=强制刷新 |
  | `release.version` | string | 本次发布版本号 |
  | `release.releasedAt` | string | 发布时间（ISO）|
  | `release.title` | string | 发布标题 |
  | `release.summary` | string | 发布摘要 |
  | `release.changes[]` | array | 变更条目列表 |

- **示例响应**：

  ```json
  {
    "latestVersion": "0.17.3",
    "updatePolicy": "optional",
    "release": {
      "version": "0.17.3",
      "releasedAt": "2026-08-12T12:00:00.000Z",
      "title": "本周更新",
      "summary": "……",
      "changes": ["新增 XX", "修复 YY"]
    }
  }
  ```

- **我们的调用点**：
  - `scripts/聚合.js` → `refreshFrontendVersion()`：启动时 GET 该接口，把 `CONFIG.frontendVersion`
    从写死的 `0.8.0` 动态刷新成 `latestVersion`（日志可见 `前端版本更新: 0.17.2 → 0.17.3`）。
  - 该接口也是 `/information?section=updates` 页面与游戏内更新弹窗的数据源。
- **备注**：
  - 前端 SPA 拿 `latestVersion` 与自身 build 版本比对，不一致且 `updatePolicy=optional` → 弹可关弹窗；
    若策略为强制则触发整页刷新。已关版本存 localStorage。
  - `x-frontend-version` 请求头是客户端上报用，不构成弹窗触发条件。
  - `api.py` 尚未封装此方法（仅 `raw "/api/meta/frontend-release"` 可查）。

---

## `/api/market/fish/events` / `/api/market/gear/events` —— 市场实时订阅（v0.18.1 新增）

- **方法**：`GET`（认证 SSE，长连接流式）
- **签名**：**免签**（已加入签名白名单；仍需登录态 cookie）
- **认证**：需要登录会话
- **说明**：v0.18.1「奥术献祭奖励与市场便利更新」新增的**市场实时行情推送端点**，供浏览器脚本/官方市场页订阅。
  官方 script-api 已封装为 `window.arcaneReelax.market.subscribeFish()` / `subscribeGear()`，底层走这两个 SSE。
  限流：每名玩家最多同时 **6 条**市场订阅，其中用户脚本最多 **4 条**，其余保留给官方市场页；
  每条连接最多订阅 **20** 种鱼（鱼类 ID 模式，不能重复）。
- **两种订阅模式**：
  1. **按鱼 ID 订阅盘口**（`{ fishIds: [...] }`）：连接建立/重连后先回调一次 `ready`，随后为每种鱼回调当前
     `order-book-updated`（含单调 `version`、前 50 个买卖聚合价位、后续游标、鱼种概览、服务端时间）；
     无挂单也发 `version=0` 空盘口。多次事件按鱼种取最大 `version`，同版本只处理一次。
  2. **低价监控**（`{ maxShopPriceMultiplier }`）：只接收「创建后仍有剩余」的新卖单，限定为商店回收价
     **1.0–2.0 倍**；鱼事件带 `orderId/fishId/unitPrice/remainingQuantity/到期时间`，装备事件带
     `orderId/unitPrice` + 完整公开装备快照（`baseStats/effectiveStats`/品质/强化/版本/获得时间，无卖家身份）。
    成交、撤单、到期、买单变化**不**产生低价事件。
- **脚本操作**（`game.market`，非 SSE，普通签名请求）：
  - `buyFish({fishId, quantity, limitUnitPrice}, {idempotencyKey})` / `sellFish({...})`：鱼类限价委托
  - `buyGear({orderId})` / `sellGear({gearId, limitUnitPrice})`：装备买卖
  - 均支持**幂等键**（重复执行同一操作不会重复交易）；服务端重新校验权限/持仓/金币/税费。
- **我们的调用点**：`api.py` 尚未封装（SSE 流式，暂可 `raw` 探测）；`market.py` 仍走 WS 桥轮询，可后续升级。

---

## 如何更新本文件

```sh
# 1) 抓首页拿当前 bundle 名（hash 随发版变）
curl -s https://reelax.cn/ | grep -oE 'assets/index-[^"]+\.js'

# 2) 下载并提取所有 /api/ 路径，与本文 diff
curl -s https://static.reelax.cn/assets/index-<HASH>.js -o /tmp/reelax.js
grep -oE '/api/[a-zA-Z0-9_/{}:.-]+' /tmp/reelax.js | sort -u
```

新增端点请补到对应分组，并在「签名」列按白名单判定；新确认的免签端点同步更新顶部白名单表。
