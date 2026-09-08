#!/bin/bash
# Restart the qy-player dev environment cleanly.
# Usage: bash scripts/restart-app.sh
# Kills Electron (+ Vite), clears the Vite transform cache, restarts both.
# The cache clear works around a recurring Vite 5.4 issue where the watcher
# transforms a file mid-write and caches a 0-byte module
# ("does not provide an export named 'default'").

cd "$(dirname "$0")/.." || exit 1

echo "==> Killing electron/vite..."
ps aux | grep -E "electron|vite" | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null
sleep 2

echo "==> Clearing Vite cache..."
rm -rf node_modules/.vite

echo "==> Starting Vite dev server (port 5173)..."
nohup npx vite --config vite.renderer.config.ts --port 5173 > /tmp/vite.log 2>&1 &
for i in $(seq 1 20); do
  curl -s http://localhost:5173/ > /dev/null 2>&1 && break
  sleep 0.5
done
curl -s http://localhost:5173/ > /dev/null 2>&1 && echo "    Vite ready." || { echo "    Vite failed to start, see /tmp/vite.log"; exit 1; }

echo "==> Starting Electron (CDP debug port: 9222)..."
env VITE_DEV_SERVER_URL=http://localhost:5173 nohup npx electron . --remote-debugging-port=9222 > /tmp/qy-app.log 2>&1 &
sleep 10

if grep -qE "does not provide|Uncaught SyntaxError" /tmp/qy-app.log; then
  echo "❌ Renderer errors detected:"
  grep -E "does not provide|Uncaught SyntaxError" /tmp/qy-app.log | head -3
  exit 1
fi
echo "✅ App running. Log: /tmp/qy-app.log"
