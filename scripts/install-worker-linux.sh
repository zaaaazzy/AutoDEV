#!/bin/bash
# Installiert den Dev-Log-Worker als systemd-Benutzerdienst (Linux): Start bei Anmeldung, Neustart bei Absturz.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
NODE_BIN="$(dirname "$(command -v node)")"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/devlog-worker.service" <<UNIT
[Unit]
Description=Dev Log Worker
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN/npm run worker
Restart=always
RestartSec=10
Environment=PATH=$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=DEV_LOG_DATABASE_URL=${DEV_LOG_DATABASE_URL:-postgresql://devlog:devlog_local_dev@localhost:5433/dev_log}

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now devlog-worker.service
echo "Worker installiert (systemctl --user status devlog-worker)"
