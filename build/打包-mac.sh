#!/bin/bash
# ===== build the macOS (arm64) portable package =====
# Run this ON the mac. Requires: curl, tar, xz. Output: ~/Desktop/简历投递工具-mac/
set -e

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # repo root
DEST="$HOME/Desktop/简历投递工具-mac"
NODE_VER="v20.19.0"
NODE_TAR="node-${NODE_VER}-darwin-arm64.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VER}/${NODE_TAR}"

echo "==> Repo: $SRC_ROOT"
mkdir -p "$DEST"

echo "==> [1/5] Downloading Node $NODE_VER (darwin-arm64) ..."
if [ ! -f "$TMPDIR/$NODE_TAR" ]; then
  curl -fL -o "$TMPDIR/$NODE_TAR" "$NODE_URL"
fi
echo "==> [2/5] Extracting node ..."
rm -rf "$TMPDIR/node-${NODE_VER}-darwin-arm64"
tar -xJf "$TMPDIR/$NODE_TAR" -C "$TMPDIR"
mkdir -p "$DEST/bin"
cp "$TMPDIR/node-${NODE_VER}-darwin-arm64/bin/node" "$DEST/bin/node"
cp -R "$TMPDIR/node-${NODE_VER}-darwin-arm64/include" "$DEST/bin/include" 2>/dev/null || true
cp -R "$TMPDIR/node-${NODE_VER}-darwin-arm64/lib" "$DEST/bin/lib" 2>/dev/null || true
cp -R "$TMPDIR/node-${NODE_VER}-darwin-arm64/share" "$DEST/bin/share" 2>/dev/null || true

echo "==> [3/5] Building resume-web-ui (release) ..."
pushd "$SRC_ROOT" >/dev/null
cargo build --release -p resume-web-ui
cp "target/release/resume-web-ui" "$DEST/resume-web-ui"
popd >/dev/null

echo "==> [4/5] Copying node-automation + static + launch scripts ..."
cp -R "$SRC_ROOT/node-automation" "$DEST/node-automation"
# strip dev droppings inside node-automation
rm -rf "$DEST/node-automation/chrome-profile-boss" "$DEST/node-automation/chrome-profile-zhaopin"
find "$DEST/node-automation" -name "*.log" -delete
mkdir -p "$DEST/logs"
[ -f "$SRC_ROOT/logs/deliver_log.json" ] && cp "$SRC_ROOT/logs/deliver_log.json" "$DEST/logs/"
mkdir -p "$DEST/cookies" "$DEST/static"
cp -R "$SRC_ROOT/web-ui/static"/* "$DEST/static/"
cp "$SRC_ROOT/build/启动-mac.command" "$DEST/启动-mac.command"
cp "$SRC_ROOT/build/打包-mac.sh" "$DEST/打包-mac.sh" 2>/dev/null || true
chmod +x "$DEST/resume-web-ui" "$DEST/启动-mac.command"

echo "==> [5/5] Prune crippled deps (electron/openai/typeorm not needed by UI scripts) ..."
for m in electron openai typeorm; do
  rm -rf "$DEST/node-automation/node_modules/$m" 2>/dev/null || true
done

echo
echo "Package ready: $DEST"
echo "Run:  $DEST/启动-mac.command   (double-click in Finder)"
echo
du -sh "$DEST" 2>/dev/null || true