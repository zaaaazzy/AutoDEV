#!/bin/bash
# Installiert den Ausfall-Wächter als macOS LaunchAgent: alle zwei Minuten ein Prüflauf
# (Dienst, HTTPS, Datenbank, Worker, Backups, Speicherplatz) mit Push-Nachricht bei Problemen.
# Die Datenbank-URL steht in ~/.config/aideation/watchdog.env (Rechte 600), nicht in der Plist.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/service-env.sh
source "$ROOT/scripts/lib/service-env.sh"
LABEL="com.aideation.watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FILE="$SERVICE_ENV_DIR/watchdog.env"
NODE_BIN="$(dirname "$(command -v node)")"
DATABASE_URL="$(resolve_value DEV_LOG_DATABASE_URL "$ENV_FILE" "$DEFAULT_DATABASE_URL")"
warn_default_password "$DATABASE_URL"
write_env_file "$ENV_FILE" \
  "DEV_LOG_DATABASE_URL=$DATABASE_URL" \
  "DEV_LOG_PUBLIC_URL=$(resolve_value DEV_LOG_PUBLIC_URL "$ENV_FILE")"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
LOG="$HOME/Library/Logs/aideation-watchdog.log"
write_private_file "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
<key>ProgramArguments</key><array>
<string>$(xml_escape "$NODE_BIN/node")</string><string>--env-file=$(xml_escape "$ENV_FILE")</string>
<string>$(xml_escape "$ROOT/node_modules/tsx/dist/cli.mjs")</string><string>src/runner/watchdog-cli.ts</string></array>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>$(xml_escape "$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")</string>
</dict>
<key>StartInterval</key><integer>120</integer>
<key>RunAtLoad</key><true/>
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
launchctl bootout "gui/$(id -u)/com.devlog.watchdog" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.devlog.watchdog.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Wächter installiert: $PLIST (Zugänge: $ENV_FILE, Log: ~/Library/Logs/aideation-watchdog.log)"
