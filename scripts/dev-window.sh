#!/usr/bin/env bash
# Opens a dev window on its own port, so it doesn't collide with Stable, Edge or
# another dev window. Takes the first free port of 1430, 1440, … or $PORT if set.
set -euo pipefail

in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null
}

port=${PORT:-}
if [ -z "$port" ]; then
  port=1430
  while in_use "$port"; do port=$((port + 10)); done
fi

echo "dev window on port $port"
exec npx tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:$port\",\"beforeDevCommand\":\"npx vite --port $port --strictPort\"}}"
