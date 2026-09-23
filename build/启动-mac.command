#!/bin/bash
# ===== Resume Auto-Apply Tool - macOS launcher =====
# Usage: put this file at the package root, then:
#   chmod +x 启动-mac.command
# and double-click it in Finder.
cd "$(dirname "$0")"

echo
echo "   ========================================"
echo "      Resume Auto-Apply Tool (macOS)"
echo "   ========================================"
echo

# 1) locate Chrome (needed by boss.mjs / zhaopin.mjs)
CHROME_PATH=""
CANDIDATES=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)
for c in "${CANDIDATES[@]}"; do
  if [ -x "$c" ]; then CHROME_PATH="$c"; break; fi
done
export CHROME_PATH
if [ -n "$CHROME_PATH" ]; then
  echo "   [OK] Chrome found: $CHROME_PATH"
else
  echo "   [WARN] Chrome not found. Install Google Chrome or set CHROME_PATH."
fi

# 2) locate node (portable copy in package root, else system node)
NODE_BIN=""
if [ -x "$(dirname "$0")/bin/node" ]; then
  NODE_BIN="$(dirname "$0")/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_BIN="/usr/local/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "   [ERROR] node missing. Put a node runtime under bin/ or install Node.js."
  read -n 1 -s -r -p "Press any key to exit..."
  echo
  exit 1
fi
echo "   [OK] Node: $NODE_BIN"

# 3) if service already running just open the browser
EXE="$(dirname "$0")/resume-web-ui"
if lsof -iTCP:3456 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "   [INFO] Service already running. Opening browser..."
  open "http://127.0.0.1:3456"
  exit 0
fi

# 4) start web-ui from package root
chmod +x "$EXE" 2>/dev/null
echo "   [START] Starting service at http://127.0.0.1:3456 ..."
nohup "$EXE" >/dev/null 2>&1 &

# 5) wait until port is listening then open browser
for i in $(seq 1 30); do
  if lsof -iTCP:3456 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! lsof -iTCP:3456 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "   [ERROR] Service start timeout. See node-automation/logs folder."
  read -n 1 -s -r -p "Press any key to exit..."
  echo
  exit 1
fi

echo "   [OK] Service ready. Opening browser..."
open "http://127.0.0.1:3456"
echo
echo "   Running. Closing this window does not stop the service."
echo "   To stop:  kill \$(lsof -tiTCP:3456 -sTCP:LISTEN)"
echo
read -n 1 -s -r -p "Press any key to close..."
echo