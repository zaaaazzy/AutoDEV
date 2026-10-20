#!/bin/bash
# Installiert den AIdeation-Worker als systemd-Benutzerdienst (Linux): Start bei Anmeldung, Neustart bei Absturz.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
NODE_BIN="$(dirname "$(command -v node)")"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/aideation-worker.service" <<UNIT
[Unit]
Description=AIdeation Worker
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN/npm run worker
Restart=always
RestartSec=10
Environment=PATH=$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=DEV_LOG_DATABASE_URL=${DEV_LOG_DATABASE_URL:-postgresql://devlog:devlog_local_dev@localhost:5433/aideation}
Environment=DEV_LOG_REVIEW_DATABASE_URL=${DEV_LOG_REVIEW_DATABASE_URL:-}
Environment=DEV_LOG_SECRET_KEY=${DEV_LOG_SECRET_KEY:-}

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now aideation-worker.service
echo "Worker installiert (systemctl --user status aideation-worker)"
