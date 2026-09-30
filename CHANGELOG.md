# 更新记录

本项目变更记录。每次 Release 会同步写到此文件并打 git tag。

## [v1.0.0] - 2026-09-30

首次发布。将本地 Reelax 钓鱼游戏脚本开发技能（reelax-script-dev）完整上传至 GitHub，覆盖原占位初始提交。

### 新增
- 浏览器扩展主体：`manifest.json`、`background.js`、`injector.js`、`bridge.js`、`monitor.js`、`api.js`、`domclick.js`、`popup.html/js`、`options.html/js`、`chrome-polyfill.js`
- 注入脚本库（`scripts/`）：自动补满次数、自动加点、自动登录、自动出售库存、聚合、以物易物价格、日报采集、保底显示、装备初始价显示、装备属性占比、一键市场等
- Python API 封装（`api/`）：`fish_economy.py`、`gear_advisor.py`、`history_economy.py`、`parse_apis.py` 及接口文档
- DevTools 工具集（`devtools/`）：请求签名、探测脚本、脚本桥（`ws_bridge.py`）、行情大屏、爬取与提取工具、安全测试脚本
- 市场模块（`market/`）：情景扫描、挂单执行、价格与装备告警、以物易物扫描、量化交易框架文档
- 游戏自动化脚本（`gaming/`）：每日报告、开箱、装备/精通商店、状态检查及 PLAYBOOK
- 文档：`SKILL.md`、`README.md`、`CONTEXT.md`、`UpdateCheck.md`、安全报告（`docs/`）
- 资源配置：`.gitignore`（忽略 `__pycache__`、生成凭据、数据库等）、`run.sh`、`LICENSE`（MIT）