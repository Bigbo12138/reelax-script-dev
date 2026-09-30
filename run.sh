#!/usr/bin/env bash
# run.sh —— 自带环境，一键启动 Firefox 并加载本扩展
#
# 作用：
#   1. 自动找到 nvm 里的 node / npx（无需手动配置 PATH）
#   2. 用 Mozilla 官方 web-ext 启动 Firefox，并把当前目录作为临时扩展载入
#   3. 自动启动 WS 桥服务端（devtools/api.py serve，端口 55004）——先于 Firefox，
#      扩展加载后 bridge.js 立刻连上，api.py 查询走 client 模式复用；端口已占用则复用
#      现有桥；设 NO_BRIDGE=1 可跳过。
#
# 用法：
#   ./run.sh                 # 用系统默认 Firefox
#   FIREFOX=/path/to/firefox ./run.sh
#   NO_BRIDGE=1 ./run.sh     # 不启动 WS 桥
#   ./run.sh --login you@example.com yourpass   # 用指定邮箱/密码登录（写入 FISH_EMAIL/FISH_PASSWD）
#   FISH_EMAIL=xxx FISH_PASSWD=yyy ./run.sh   # 或直接设环境变量，自动登录.js 优先读取
#   ./run.sh -- --devtools   # 把额外参数透传给 web-ext（例如 --devtools 打开调试器）
#
# 注意：
#   - 首次运行会通过 npx 下载 web-ext，需要联网。
#   - web-ext 以“临时载入”方式加载扩展，浏览器完全关闭后失效，需重新运行本脚本。
#   - 需要图形显示环境（本地桌面，或容器里的 VNC/Xvfb）。

set -u

SUDO_PASS="${SUDO_PASS:-ubuntu}"

# ---------- 0. 命令行参数解析 ----------
# 支持 --login <邮箱> <密码>：把登录凭据写入环境变量 FISH_EMAIL / FISH_PASSWD，
# 后续生成 scripts/login_credentials.js 交给扩展注入自动登录.js（见 0.1 节）。
# 剩余参数原样透传给 web-ext（如 -- --devtools）。
LOGIN_EMAIL=""
LOGIN_PASSWD=""
REST_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --login)
      shift
      if [ "$#" -lt 2 ]; then
        echo "❌ --login 需要两个参数：--login <邮箱> <密码>" >&2
        exit 2
      fi
      LOGIN_EMAIL="$1"; shift
      LOGIN_PASSWD="$1"; shift
      # 参数优先于已有的环境变量
      FISH_EMAIL="$LOGIN_EMAIL"
      FISH_PASSWD="$LOGIN_PASSWD"
      ;;
    --)
      shift
      REST_ARGS+=("$@")
      break
      ;;
    -*)
      echo "⚠️  未知参数：$1（透传给 web-ext）" >&2
      REST_ARGS+=("$1"); shift
      ;;
    *)
      REST_ARGS+=("$1"); shift
      ;;
  esac
done
set -- "${REST_ARGS[@]}"


# 脚本所在目录（重跑时要用绝对路径）
SCRIPT_DIR0="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

# ---------- 0. 以 root 运行时，自动切换为 ubuntu ----------
# 原因：Firefox 在 root 下会因 sandbox/userns 的 EPERM 而启动失败，远程调试端口
# 开不起来，web-ext 连接即报 ECONNREFUSED(127.0.0.1:xxxx)。必须以 ubuntu 身份运行。
# 这里先以 root 放开权限（ubuntu 才能进 /root 读 node、读扩展目录），再以 ubuntu
# 重新执行本脚本，等价于手动 `su ubuntu -c 'cd <dir> && ./run.sh'`。
if [ "$(id -u)" -eq 0 ]; then
  chmod o+x /root /root/.nvm /root/.nvm/versions /root/.nvm/versions/node /root/.nvm/versions/node/v22.23.1 /root/.nvm/versions/node/v22.23.1/bin 2>/dev/null
  chmod -R a+rX /root/.nvm/versions/node/v22.23.1 2>/dev/null
  for d in "$SCRIPT_DIR0" "$(dirname "$SCRIPT_DIR0")" /workspace; do
    [ -d "$d" ] && chmod o+x "$d" 2>/dev/null
  done
  chmod -R a+rX "$SCRIPT_DIR0" 2>/dev/null
  [ -f /home/ubuntu/.Xauthority ] && chmod a+r /home/ubuntu/.Xauthority 2>/dev/null
  echo "🔄 检测到 root，自动以 ubuntu 身份重跑本脚本（避免 Firefox sandbox EPERM）..."
  exec su ubuntu -c "cd '$SCRIPT_DIR0' && exec '$SCRIPT_DIR0/run.sh' $(printf '%q ' "$@")"
fi

# ---------- 0. 权限兜底（ubuntu 下用 sudo 提权） ----------
# 走到这里一定是非 root（ubuntu）。ubuntu 默认进不去 /root 与扩展目录，需要用
# sudo + 密码提权 chmod，确保能访问 node 与扩展文件。固定 node 路径：
# /root/.nvm/versions/node/v22.23.1/bin
if [ "$(id -u)" -ne 0 ]; then
  # 普通用户（ubuntu）：用 sudo -S 喂密码提权
  SUDO_PRIV="echo \"$SUDO_PASS\" | sudo -S"
else
  # root：理论上不会到这（上面已重跑），保险起见直接执行
  SUDO_PRIV=""
fi

# 放开 /root 链路权限，让 ubuntu 能进入并读取 /root/.nvm 下的 node
eval "$SUDO_PRIV chmod o+x /root /root/.nvm /root/.nvm/versions /root/.nvm/versions/node /root/.nvm/versions/node/v22.23.1 /root/.nvm/versions/node/v22.23.1/bin" 2>/dev/null
eval "$SUDO_PRIV chmod -R a+rX /root/.nvm/versions/node/v22.23.1" 2>/dev/null

# 放开扩展根目录的进入与读取权限（链路上各级目录都需 o+x 才能 cd 进去）
for d in "$SCRIPT_DIR0" "$(dirname "$SCRIPT_DIR0")" /workspace; do
  [ -d "$d" ] && eval "$SUDO_PRIV chmod o+x \"$d\"" 2>/dev/null
done
eval "$SUDO_PRIV chmod -R a+rX \"$SCRIPT_DIR0\"" 2>/dev/null

# 确保 ubuntu 能读取自己的 Xauthority（若存在）
if [ -f /home/ubuntu/.Xauthority ]; then
  eval "$SUDO_PRIV chmod a+r /home/ubuntu/.Xauthority" 2>/dev/null
fi

# 0.5 扩展目录属主兜底：整个目录改成 ubuntu，保证 run.sh 后续写 scripts/login_credentials.js 等文件不因 root 属主而 Permission denied
if [ "$(id -u)" -ne 0 ]; then
  eval "$SUDO_PRIV chown -R ubuntu:ubuntu '$SCRIPT_DIR0'" 2>/dev/null
fi

# ---------- 1. 定位 node / npx（固定路径） ----------
NODE_BIN="/root/.nvm/versions/node/v22.23.1/bin"

if [ ! -x "$NODE_BIN/node" ]; then
  echo "❌ 找不到 node: $NODE_BIN/node" >&2
  echo "   请确认 /root/.nvm/versions/node/v22.23.1 存在，或在 root 下执行：" >&2
  echo "   chmod -R a+rX /root/.nvm/versions/node/v22.23.1 && chmod o+x /root /root/.nvm /root/.nvm/versions /root/.nvm/versions/node" >&2
  exit 1
fi

export PATH="$NODE_BIN:$PATH"
echo "✓ 使用 node: $("$NODE_BIN/node" --version)  (来自 $NODE_BIN)"

# ---------- 2. 定位 Firefox ----------
FIREFOX="${FIREFOX:-$(command -v firefox || command -v firefox-esr || true)}"
if [ -z "$FIREFOX" ]; then
  echo "⚠️  未自动发现 firefox，web-ext 会尝试自己查找；若失败请设置 FIREFOX=/path/to/firefox" >&2
fi

# ---------- 2.5 显示环境（固定为容器 VNC 桌面 :1002） ----------
# 本镜像的可见桌面是 TurboVNC（rfbport 5901 / DISPLAY :1002），通过 noVNC(4002) 查看。
# 直接写死 :1002，确保 Firefox 一定画到这个桌面上。
export DISPLAY=":1002"
export XAUTHORITY=/home/ubuntu/.Xauthority
# 容器 seccomp 禁用了 unprivileged user namespace，Firefox 沙箱 clone(CLONE_NEWUSER) 会 EPERM
# 导致浏览器启动即退出。这里禁用 Firefox 内容沙箱（环境变量 + pref 双保险）规避。
export MOZ_DISABLE_CONTENT_SANDBOX=1
echo "🖥️  DISPLAY=$DISPLAY  XAUTHORITY=$XAUTHORITY"

# ---------- 2.6 等待 :1002 屏幕就绪（VNC 桌面可能还没起来） ----------
# 屏幕没起来就启动 Firefox 会因无法连上 X server 而失败。这里循环检测：
# 每 10 秒用 xdpyinfo 探测一次 :1002，直到屏幕可连接（或超过最大等待次数）再继续。
# 可用 MAX_WAIT_MINUTES 覆盖最大等待分钟数（默认 10 分钟，即最多 60 次探测）。
MAX_WAIT_MINUTES="${MAX_WAIT_MINUTES:-10}"
if command -v xdpyinfo >/dev/null 2>&1; then
  echo "⏳ 等待屏幕 :1002 就绪 ..." 
  screen_ok=0
  for i in $(seq 1 $((MAX_WAIT_MINUTES * 6))); do
    if xdpyinfo -display ":1002" >/dev/null 2>&1; then
      screen_ok=1
      echo "✅ 屏幕 :1002 已就绪（第 ${i} 次探测成功）"
      break
    fi
    echo "   ⏳ 屏幕 :1002 尚未就绪，10s 后重试（${i}/$((MAX_WAIT_MINUTES * 6))）..."
    sleep 10
  done
  if [ "$screen_ok" -eq 0 ]; then
    echo "❌ 等待 ${MAX_WAIT_MINUTES} 分钟后屏幕 :1002 仍不可用，放弃启动 Firefox。" >&2
    exit 1
  fi
else
  echo "⚠️  未找到 xdpyinfo，跳过屏幕检测（将直接尝试启动 Firefox）" >&2
fi

# ---------- 3. 切到脚本所在目录（扩展根目录）----------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# ---------- 3.5 生成运行期配置（scripts/login_credentials.js，同一份文件） ----------
# 把环境变量 FISH_EMAIL / FISH_PASSWD / FISH_WEBHOOK 写成一个运行期 JS 文件：
#   · injector.js 先注入主世界，自动登录.js 从 __REELAX_LOGIN__ 拿账号密码；
#   · monitor.js（扩展后台）fetch 同一份文件，从 webhook 字段拿企微完整 URL（统一发通知）。
# 该文件被 .gitignore 忽略、不入库。
# - email/password/webhook 任一非空 → 生成；全部为空 → 删除旧文件（自动登录/企微告警不启用）。
LOGIN_CRED_FILE="$SCRIPT_DIR/scripts/login_credentials.js"
if [ -n "${FISH_EMAIL:-}" ] || [ -n "${FISH_PASSWD:-}" ] || [ -n "${FISH_WEBHOOK:-}" ]; then
  cat > "$LOGIN_CRED_FILE" <<EOF
// 自动生成（run.sh 依据 FISH_EMAIL / FISH_PASSWD / FISH_WEBHOOK），勿手改
window.__REELAX_LOGIN__ = { email: "${FISH_EMAIL:-}", password: "${FISH_PASSWD:-}", webhook: "${FISH_WEBHOOK:-}" };
EOF
  echo "🔑 已注入登录凭据：$FISH_EMAIL (密码已按环境变量/--login 覆盖)"
else
  if [ -f "$LOGIN_CRED_FILE" ]; then
    rm -f "$LOGIN_CRED_FILE"
    echo "🔑 未设置 FISH_EMAIL/FISH_PASSWD/FISH_WEBHOOK，已移除运行期配置（自动登录/企微告警不启用）"
  fi
fi

# ---------- 4. 启动 web-ext（带启动日志） ----------
EXTRA_ARGS=("$@")   # 支持 ./run.sh -- --devtools 等透传参数

# 固定窗口大小（不全屏）
WIN_W="${WIN_W:-1120}"
WIN_H="${WIN_H:-600}"

# ---------- 4.5 Firefox 偏好注入（写进临时 profile 的 prefs.js） ----------
# 通过 web-ext --pref 注入，等价于手动改 about:config，但只对本次临时启动生效。
# 例：下载完成后不自动弹出底部下载面板（避免每次导出/自动保存日志后都要手动收起）。
# 想加更多偏好就往这个数组里继续加 "--pref=xxx=yyy" 即可。
PREFS=(
  "--pref=browser.download.alwaysOpenPanel=false"
  "--pref=ui.prefersReducedMotion=1"
  "--pref=browser.uitour.enabled=false"
  "--pref=browser.download.animateNotifications=false"
  "--pref=dom.webnotifications.enabled=false"
  "--pref=devtools.chrome.enabled=true"
  "--pref=browser.translations.enable=false"
  "--pref=browser.translations.automaticallyPopup=false"
  "--pref=security.pki.crlite_mode=0"
  "--pref=gfx.webrender.software=true"
  "--pref=security.sandbox.content.level=0"
  "--pref=layers.acceleration.disabled=true"
  "--pref=dom.ipc.processCount=8"
  "--pref=image.mem.decode_bytes_at_a_time=262144"
  '--pref=browser.uiCustomization.state={"placements":{"widget-overflow-fixed-list":[],"unified-extensions-area":[],"nav-bar":["back-button","forward-button","stop-reload-button","customizableui-special-spring1","vertical-spacer","urlbar-container","customizableui-special-spring2","downloads-button","fxa-toolbar-menu-button","reset-pbm-toolbar-button","unified-extensions-button","reelax-helper@local-browser-action"],"toolbar-menubar":["menubar-items"],"TabsToolbar":["firefox-view-button","tabbrowser-tabs","new-tab-button","alltabs-button"],"vertical-tabs":[],"PersonalToolbar":["personal-bookmarks"]},"seen":["reset-pbm-toolbar-button","reelax-helper@local-browser-action","developer-button","screenshot-button"],"dirtyAreaCache":["unified-extensions-area","nav-bar","vertical-tabs"],"currentVersion":24,"newElementCount":2}'
)

# 启动日志：把 web-ext 全部输出（含 --verbose 诊断）落盘，无论成功失败都留痕，
# 方便事后排查（例如 Firefox 起不来 / 扩展 manifest 无效 / 调试端口连不上）。
LOG_DIR="${LOG_DIR:-/home/ubuntu/Downloads}"
mkdir -p "$LOG_DIR" 2>/dev/null
LOGFILE="$LOG_DIR/firefoxfish-launch-$(date +%Y%m%d-%H%M%S).log"
echo "📝 启动日志: $LOGFILE" | tee -a "$LOGFILE"

# ---------- 4.2 WS 桥启动（先于 Firefox，扩展加载即连上） ----------
# 扩展后台 bridge.js 作为 WS 客户端连 127.0.0.1:55004。先起桥服务端，扩展加载后立刻连上，
# popup 直接显示已连接；之后 api.py 命令走 client 模式复用（见 SKILL.md「WS 桥教程」）。
# 设 NO_BRIDGE=1 可跳过。
#
# ⚠️ 关键解耦原则：桥与 Firefox 完全独立。
#    - 杀/重启桥【只】匹配 'api.py serve'，**绝不**匹配 firefox / web-ext，
#      因此重启桥不会动到浏览器，扩展 bridge.js 会自动重连（见 bridge.js 重连逻辑）。
#    - 启动后做端口探活，避免「进程假活 / 绑定失败却打印成功」的问题（本次 55004 曾因
#      TIME_WAIT 残留导致 asyncio.start_server 绑定失败、WS 线程崩溃、主进程变假活）。

# 仅杀旧桥进程（绝不碰 firefox / web-ext），并等到它真正退出。
# 用精确 pattern 'api.py serve' 匹配桥，不会误伤浏览器。
kill_bridge_only() {
  pkill -TERM -f 'api.py serve' 2>/dev/null || true
  # 等进程真正退出（最多 10 秒），避免后面绑定端口时旧进程还在
  for _k in $(seq 1 10); do
    if ! pgrep -f 'api.py serve' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  # 仍没退，发 KILL
  pkill -KILL -f 'api.py serve' 2>/dev/null || true
  sleep 1
}

# 端口 55004 是否在监听（即桥进程真的起来了）。不依赖具体进程，只看端口。
bridge_alive() {
  (exec 3<>"/dev/tcp/127.0.0.1/55004") 2>/dev/null
}

# 启动（或重启）桥：先精准杀旧桥 → 等端口释放 → 拉起 → 端口探活确认真活。
# 成功返回 0 并打印 ✅；失败返回 1 并打印 ❌（绝不假装成功）。
start_bridge() {
  BRIDGE_LOG="$LOG_DIR/bridge-$(date +%Y%m%d-%H%M%S).log"
  echo "🚀 启动 WS 桥服务端（api.py serve，端口 55004）..." | tee -a "$LOGFILE"

  # 1) 若端口已占用，只杀旧桥（不碰 firefox），等释放
  if bridge_alive; then
    exec 3>&- 2>/dev/null
    echo "🔁 55004 已被占用，仅重启桥进程（不动 Firefox）..." | tee -a "$LOGFILE"
    kill_bridge_only
    # 等端口真正释放（含 TIME_WAIT 余量，最多 12 秒）
    for _w in $(seq 1 12); do
      if ! bridge_alive; then break; fi
      exec 3>&- 2>/dev/null
      sleep 1
    done
  fi

  # 2) 拉起新桥
  if ! command -v python3 >/dev/null 2>&1; then
    echo "⚠️  未找到 python3，跳过 WS 桥启动（桥查询不可用）" >&2
    return 1
  fi
  nohup python3 devtools/api.py serve >"$BRIDGE_LOG" 2>&1 &
  BRIDGE_PID=$!
  echo "   桥进程 pid=$BRIDGE_PID，日志: $BRIDGE_LOG" | tee -a "$LOGFILE"

  # 3) 端口探活：最多等 15 秒确认真正在监听（区分「真活」与「绑定失败假活」）
  for _p in $(seq 1 15); do
    if bridge_alive; then
      exec 3>&- 2>/dev/null
      echo "✅ WS 桥已就绪 (pid=$BRIDGE_PID)：ws://0.0.0.0:55004 端口可连接，日志: $BRIDGE_LOG" | tee -a "$LOGFILE"
      return 0
    fi
    exec 3>&- 2>/dev/null
    sleep 1
  done

  # 4) 超时仍未监听 → 桥崩溃（假活），明确报错，绝不打 ✅
  echo "❌ WS 桥未就绪：端口 55004 在 15 秒内未监听，桥进程可能已崩溃（假活）。请看日志: $BRIDGE_LOG" | tee -a "$LOGFILE"
  echo "   （仅桥起不来，Firefox 不受影响；可手动 `python3 devtools/api.py serve` 或重跑本脚本）" | tee -a "$LOGFILE"
  return 1
}

BRIDGE_PID=""
if [ "${NO_BRIDGE:-0}" = "1" ]; then
  echo "⏭️  NO_BRIDGE=1，跳过 WS 桥启动" | tee -a "$LOGFILE"
else
  start_bridge || true   # 失败不阻断 Firefox 启动；守护循环会兜底
fi

# ---------- 4.3 launch_webext：启动 web-ext（后台管道）并设置 WEBEXT_PID ----------
# 封装成函数：这样 2 分钟监控循环发现 Firefox 挂掉后可以自动重新走一遍启动。
launch_webext() {
  echo "🚀 [$(date '+%F %T')] 启动 Firefox 并加载扩展 ($(pwd)) ..." | tee -a "$LOGFILE"
  if [ -n "$FIREFOX" ]; then
    WEBEXT_CMD=(npx --yes web-ext run --verbose \
      --firefox-binary "$FIREFOX" \
      --source-dir "$SCRIPT_DIR" \
      --args="-width" --args="$WIN_W" \
      --args="-height" --args="$WIN_H" \
      "${PREFS[@]}" \
      "${EXTRA_ARGS[@]}")
  else
    WEBEXT_CMD=(npx --yes web-ext run --verbose \
      --source-dir "$SCRIPT_DIR" \
      --args="-width" --args="$WIN_W" \
      --args="-height" --args="$WIN_H" \
      "${PREFS[@]}" \
      "${EXTRA_ARGS[@]}")
  fi

  # 后台启动：stdout+stderr 同时写日志文件和终端
  # 过滤掉 Firefox 内部常见的 services.settings 等 console.warn 刷屏日志，避免干扰终端。
  # 注：只删噪音行，不影响"Remote debugging port" / "Running web extension from" 等关键行，
  #     因此下面的启动检测逻辑依然有效。
  "${WEBEXT_CMD[@]}" 2>&1 | \
    sed -E '/\[debug\] Firefox stdout: console\.(warn|error): (services\.settings|RemoteSecuritySettings):/d' | \
    tee -a "$LOGFILE" &
  WEBEXT_PID=$!
}

# Ctrl-C / 终止时，连带停掉 web-ext 及其 Firefox 子进程（进程组）、本脚本起的 WS 桥和定时巡检
DIARY_PID=""
cleanup() {
  echo "🛑 收到退出信号，正在停止 Firefox ..." | tee -a "$LOGFILE"
  kill -TERM -"$WEBEXT_PID" 2>/dev/null
  wait "$WEBEXT_PID" 2>/dev/null
  if [ -n "${DIARY_PID:-}" ]; then
    echo "🛑 停止定时巡检 (pid=$DIARY_PID) ..." | tee -a "$LOGFILE"
    kill -TERM "$DIARY_PID" 2>/dev/null
  fi
  if [ -n "${BRIDGE_PID:-}" ]; then
    echo "🛑 停止 WS 桥 (pid=$BRIDGE_PID) ..." | tee -a "$LOGFILE"
    kill -TERM "$BRIDGE_PID" 2>/dev/null
  fi
  exit 0
}
trap cleanup INT TERM

# ---------- 4.4 wait_webext_ready：轮询等待 Firefox 远程调试端口就绪 ----------
# 端口号来自 web-ext 传给 Firefox 的命令行参数 "-start-debugger-server <port>"
# （本 web-ext 版本的日志不含 "Remote debugging port:" 字样，只能从这里解析）。
# 首启慢，最多等 60s；端口解析到后还要 TCP 探活通过才算就绪。
# 返回 0=就绪/已加载；返回 1=web-ext 已退出（供监控循环决定是否重启）。
wait_webext_ready() {
  PORT=""
  PORT_READY=0
  for i in $(seq 1 60); do
    if ! kill -0 "$WEBEXT_PID" 2>/dev/null; then
      echo "❌ [$(date '+%F %T')] web-ext 启动过程中退出，启动失败。详见日志: $LOGFILE" | tee -a "$LOGFILE"
      wait "$WEBEXT_PID" 2>/dev/null
      return 1
    fi
    # 解析端口号（只解析一次）
    if [ -z "$PORT" ]; then
      PORT=$(grep -oE 'start-debugger-server [0-9]+' "$LOGFILE" 2>/dev/null | tail -1 | grep -oE '[0-9]+')
    fi
    # 端口已解析 → TCP 探活：确认 127.0.0.1:PORT 真的在监听才判定就绪
    if [ -n "$PORT" ]; then
      if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
        exec 3>&- 2>/dev/null
        PORT_READY=1
        break
      fi
    fi
    sleep 1
  done

  # 最终判定启动结果
  RUNNING=$(grep -c "Running web extension from" "$LOGFILE" 2>/dev/null)
  if [ "$PORT_READY" -eq 1 ]; then
    echo "✅ [$(date '+%F %T')] 启动成功：Firefox 远程调试端口=$PORT 已就绪（TCP 探活通过），扩展已加载。日志: $LOGFILE" | tee -a "$LOGFILE"
  elif [ -n "$PORT" ]; then
    echo "⚠️ 已启动：解析到调试端口=$PORT，但 60s 内 TCP 探活未通过（端口未在监听），可能仍在加载。详见日志: $LOGFILE" | tee -a "$LOGFILE"
  elif [ "${RUNNING:-0}" -gt 0 ]; then
    echo "✅ [$(date '+%F %T')] 启动成功：扩展已加载（未解析到调试端口，但 web-ext 已在运行）。日志: $LOGFILE" | tee -a "$LOGFILE"
  else
    echo "⚠️ 已启动，但 60s 内未检测到扩展加载/调试端口，可能仍在加载或扩展未生效。详见日志: $LOGFILE" | tee -a "$LOGFILE"
  fi
  return 0
}

# ---------- 5. 挂机定时巡检：每 1.5 小时跑一次 check.py --diary ----------
# 启动成功后才开跑：先立即跑一次打底，之后每 DIARY_INTERVAL_MIN 分钟（默认 90=1.5h）
# 跑一次 gaming/check.py --diary，自动更新游戏日记 Issue#3 并算速率。
# 设 NO_DIARY=1 关闭；需要 CNB_TOKEN（su 不重置环境变量，export 后可直接透传）。
if [ "${NO_DIARY:-0}" = "1" ]; then
  echo "⏭️  NO_DIARY=1，跳过定时巡检" | tee -a "$LOGFILE"
elif [ -z "${CNB_TOKEN:-}" ]; then
  echo "⚠️  未设置 CNB_TOKEN，跳过定时巡检（如需开启：export CNB_TOKEN=xxx 后重跑 run.sh）" | tee -a "$LOGFILE"
else
  DIARY_INTERVAL_MIN="${DIARY_INTERVAL_MIN:-90}"
  echo "🕐 定时巡检已开启：先跑一次，之后每 ${DIARY_INTERVAL_MIN} 分钟跑 check.py --diary" | tee -a "$LOGFILE"
  (
    while true; do
      echo "--- 🕐 定时巡检 $(date '+%F %T') ---" | tee -a "$LOGFILE"
      (cd "$SCRIPT_DIR" && python3 gaming/check.py --diary) 2>&1 | tee -a "$LOGFILE"
      sleep $((DIARY_INTERVAL_MIN * 60))
    done
  ) &
  DIARY_PID=$!
fi

# ---------- 6. 2 分钟守护循环：Firefox 挂掉则自动重走启动流程 ----------
# 每 MONITOR_INTERVAL_MIN 分钟（默认 2）检查一次 Firefox 主进程是否存活；
# 若已退出，则自动清理残留并重新调用 launch_webext + wait_webext_ready 重启，并写日志。
# 设 MONITOR=0 关闭守护（退化为原来的前台 wait 行为）。
MONITOR="${MONITOR:-1}"
MONITOR_INTERVAL_MIN="${MONITOR_INTERVAL_MIN:-2}"
RESTART_COUNT=0
MAX_RESTARTS="${MAX_RESTARTS:-50}"

# 检测 Firefox 主进程（带 -profile 的 /usr/lib/firefox/firefox）或 web-ext 是否存活
firefox_alive() {
  pgrep -f "/usr/lib/firefox/firefox .* -profile " >/dev/null 2>&1 \
    || pgrep -f "web-ext run" >/dev/null 2>&1
}

# 首次启动
launch_webext
if ! wait_webext_ready; then
  echo "⚠️ [$(date '+%F %T')] 首次启动未就绪，交由守护循环稍后自动重启。" | tee -a "$LOGFILE"
fi

if [ "${MONITOR:-1}" = "0" ]; then
  echo "⏭️  MONITOR=0，跳过 2 分钟守护，退化为前台 wait" | tee -a "$LOGFILE"
  wait "$WEBEXT_PID"
  exit 0
fi

echo "🛡️  2 分钟守护已开启：每 ${MONITOR_INTERVAL_MIN} 分钟检查（先查桥、再查 Firefox；挂了各自独立重启，互不波及）（最多 ${MAX_RESTARTS} 次 Firefox 重启）。" | tee -a "$LOGFILE"
while true; do
  sleep $((MONITOR_INTERVAL_MIN * 60))

  # —— ① 先查桥（独立）：桥挂了只重启桥，绝不动 Firefox ——
  if [ "${NO_BRIDGE:-0}" != "1" ] && ! bridge_alive; then
    echo "⚠️ [$(date '+%F %T')] 检测到 WS 桥（55004）未监听！仅重启桥（不动 Firefox）..." | tee -a "$LOGFILE"
    start_bridge || echo "   ↳ 桥重启仍失败，下一轮再试（Firefox 不受影响）" | tee -a "$LOGFILE"
  fi

  # —— ② 再查 Firefox ——
  if firefox_alive; then
    echo "✓ [$(date '+%F %T')] Firefox 运行正常（守护第 ${RESTART_COUNT} 次通过）" | tee -a "$LOGFILE"
    continue
  fi
  # Firefox 挂了 → 记录并重启
  RESTART_COUNT=$((RESTART_COUNT + 1))
  echo "⚠️ [$(date '+%F %T')] 检测到 Firefox 进程消失！自动重启（第 ${RESTART_COUNT}/${MAX_RESTARTS} 次）..." | tee -a "$LOGFILE"
  if [ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]; then
    echo "❌ [$(date '+%F %T')] 达到最大重启次数 ${MAX_RESTARTS}，停止守护。" | tee -a "$LOGFILE"
    break
  fi
  # 清理可能残留的 web-ext / 旧 Firefox（连带进程组）
  kill -TERM -"$WEBEXT_PID" 2>/dev/null
  wait "$WEBEXT_PID" 2>/dev/null
  pkill -TERM -f "web-ext run" 2>/dev/null
  pkill -TERM -f "/usr/lib/firefox/firefox" 2>/dev/null
  sleep 3
  # 重新走一遍启动流程（先确保桥活着，再重起 Firefox）
  if [ "${NO_BRIDGE:-0}" != "1" ] && ! bridge_alive; then
    start_bridge || true
  fi
  launch_webext
  wait_webext_ready
done

