#!/bin/bash
# Installiert den AIdeation-Worker als macOS LaunchAgent (Autostart, Neustart bei Absturz).
# Der Worker bedient alle im AIdeation registrierten Projekte, jeweils im eigenen Projektordner.
# Zugänge (DEV_LOG_DATABASE_URL, DEV_LOG_SECRET_KEY) kommen in ~/.config/aideation/worker.env (Rechte 600),
# nicht in die Plist; scripts/run-with-env.sh liest sie beim Start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/service-env.sh
source "$ROOT/scripts/lib/service-env.sh"
LABEL="com.aideation.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FILE="$SERVICE_ENV_DIR/worker.env"
NODE_BIN="$(dirname "$(command -v node)")"
# launchd startet mit minimalem PATH; externe Agent-CLIs (claude, copilot, gemini) liegen oft in
# ~/.local/bin oder /opt/homebrew/bin. Deshalb den PATH der aufrufenden Shell übernehmen.
WORKER_PATH="$NODE_BIN:$HOME/.local/bin:/opt/homebrew/bin:$PATH:/usr/local/bin:/usr/bin:/bin"
for cli in claude copilot gemini; do
  if command -v "$cli" >/dev/null 2>&1; then echo "Gefunden: $cli → $(command -v "$cli")"; fi
done
DATABASE_URL="$(resolve_value DEV_LOG_DATABASE_URL "$ENV_FILE" "$DEFAULT_DATABASE_URL")"
warn_default_password "$DATABASE_URL"
write_env_file "$ENV_FILE" \
  "DEV_LOG_DATABASE_URL=$DATABASE_URL" \
  "DEV_LOG_REVIEW_DATABASE_URL=$(resolve_value DEV_LOG_REVIEW_DATABASE_URL "$ENV_FILE")" \
  "DEV_LOG_OLLAMA_MODEL=$(resolve_value DEV_LOG_OLLAMA_MODEL "$ENV_FILE" "qwen3.5:9b")" \
  "DEV_LOG_SECRET_KEY=$(resolve_value DEV_LOG_SECRET_KEY "$ENV_FILE")"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
LOG="$HOME/Library/Logs/aideation-worker.log"
# Node startet direkt und liest die Zugänge selbst (--env-file): Unter macOS darf ein Hintergrunddienst /bin/bash
# nicht auf externe Laufwerke zugreifen („Operation not permitted“), node mit der Freigabe des Benutzers schon.
write_private_file "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
<key>ProgramArguments</key><array>
<string>$(xml_escape "$NODE_BIN/node")</string><string>--env-file=$(xml_escape "$ENV_FILE")</string>
<string>$(xml_escape "$ROOT/node_modules/tsx/dist/cli.mjs")</string><string>src/runner/runner-cli.ts</string>
<string>--all</string><string>--watch</string><string>--limit</string><string>3</string></array>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>$(xml_escape "$WORKER_PATH")</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
<key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
</dict></plist>
P
plutil -lint -s "$PLIST"
if install_dry_run; then
  echo "Probelauf: $PLIST und $ENV_FILE geschrieben, Dienst nicht registriert."
  exit 0
fi
# Frühere Bezeichnung (Dev Log) abräumen.
launchctl bootout "gui/$(id -u)/com.devlog.worker" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.devlog.worker.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Worker installiert: $PLIST (Zugänge: $ENV_FILE, Log: ~/Library/Logs/aideation-worker.log)"
