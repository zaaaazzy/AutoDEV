#!/bin/bash
# Installiert den AIdeation-Worker als systemd-Benutzerdienst (Linux): Start bei Anmeldung, Neustart bei Absturz.
# Zugänge (DEV_LOG_DATABASE_URL, DEV_LOG_SECRET_KEY) kommen in ~/.config/aideation/worker.env (Rechte 600),
# nicht in die Unit; scripts/run-with-env.sh liest sie beim Start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/service-env.sh
source "$ROOT/scripts/lib/service-env.sh"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/aideation-worker.service"
ENV_FILE="$SERVICE_ENV_DIR/worker.env"
# Echter Pfad statt Shim/Sitzungspfad (fnm, Volta): der Dienst startet später ohne die Shell-Umgebung.
NODE_BIN="$(dirname "$(node -p process.execPath)")"
DATABASE_URL="$(resolve_value DEV_LOG_DATABASE_URL "$ENV_FILE" "$DEFAULT_DATABASE_URL")"
warn_default_password "$DATABASE_URL"
write_env_file "$ENV_FILE" \
  "DEV_LOG_DATABASE_URL=$DATABASE_URL" \
  "DEV_LOG_REVIEW_DATABASE_URL=$(resolve_value DEV_LOG_REVIEW_DATABASE_URL "$ENV_FILE")" \
  "DEV_LOG_OLLAMA_MODEL=$(resolve_value DEV_LOG_OLLAMA_MODEL "$ENV_FILE" "qwen3.5:9b")" \
  "DEV_LOG_SECRET_KEY=$(resolve_value DEV_LOG_SECRET_KEY "$ENV_FILE")"
write_private_file "$UNIT" <<UNIT
[Unit]
Description=AIdeation Worker
After=network-online.target

[Service]
WorkingDirectory=$(systemd_path "$ROOT")
ExecStart=/bin/bash $(systemd_quote "$ROOT/scripts/run-with-env.sh" exec) $(systemd_quote "$ENV_FILE" exec) $(systemd_quote "$NODE_BIN/npm" exec) run worker
Restart=always
RestartSec=10
Environment=$(systemd_quote "PATH=$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin")

[Install]
WantedBy=default.target
UNIT
if install_dry_run; then
  echo "Probelauf: $UNIT und $ENV_FILE geschrieben, Dienst nicht registriert."
  exit 0
fi
systemctl --user daemon-reload
systemctl --user enable --now aideation-worker.service
echo "Worker installiert (systemctl --user status aideation-worker, Zugänge: $ENV_FILE)"
