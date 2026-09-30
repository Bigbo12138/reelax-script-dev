# 更新记录

本项目变更记录。每次 Release 会同步写到此文件并打 git tag。

## [v1.1.0] - 2026-09-30

### 更新
- **README 重写**：更新为 Chrome/Edge Manifest V3 版说明，替换原 Firefox 版文档。补充功能清单（自动切图+补满、自动出售、自动加点/加专精、保底监控、自动开公会增益、掉线/登录失效监控、一键市场含可议价重挂、日报采集、行情 SSE 采集）、Python 桥用法、文件结构、安装（`chrome://extensions` 加载已解压扩展）、配置说明与深入文档指引。

### 数据
- `data/daily_raw.json`：更新当日运行数据（`activeSec`、保底进度 `pity` 等）。

### 安全 / 隐私清理
- `devtools/test_admin_login.py`：将爆破测试中的**真实第三方账号**脱敏为占位符 `admin@REDACTED.example`，并标注禁止对他人账号执行。
- `docs/security-report.md`：将「已知管理员邮箱」真实邮箱打码为 `admin@REDACTED.example`（已脱敏）。
- `run.sh`：用法示例中的示例邮箱/密码改为通用占位 `you@example.com / yourpass`。

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