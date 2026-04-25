#!/bin/bash
# start-claudeclaw.sh — Start ClaudeClaw without systemd
# To stop: kill $(cat /home/claude/my-assistant/claudeclaw/claudeclaw.pid)

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/home/claude/.local/bin"
cd "/home/claude/my-assistant/claudeclaw"

# Stop existing instance if running
if [ -f "/home/claude/my-assistant/claudeclaw/claudeclaw.pid" ]; then
  OLD_PID=$(cat "/home/claude/my-assistant/claudeclaw/claudeclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing ClaudeClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting ClaudeClaw..."
nohup "/usr/bin/node" "/home/claude/my-assistant/claudeclaw/dist/service.js" \
  >> "/home/claude/my-assistant/claudeclaw/logs/claudeclaw.log" \
  2>> "/home/claude/my-assistant/claudeclaw/logs/claudeclaw.error.log" &

echo $! > "/home/claude/my-assistant/claudeclaw/claudeclaw.pid"
echo "ClaudeClaw started (PID $!)"
echo "Logs: tail -f /home/claude/my-assistant/claudeclaw/logs/claudeclaw.log"
