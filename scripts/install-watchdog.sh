#!/bin/bash
# Installiert den Ausfall-Wächter als macOS LaunchAgent: alle zwei Minuten ein Prüflauf
# (Dienst, HTTPS, Datenbank, Worker, Backups, Speicherplatz) mit Push-Nachricht bei Problemen.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.devlog.watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(dirname "$(command -v node)")"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>WorkingDirectory</key><string>$ROOT</string>
<key>ProgramArguments</key><array>
<string>$NODE_BIN/npm</string><string>run</string><string>--silent</string><string>watchdog</string></array>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
<key>DEV_LOG_DATABASE_URL</key><string>${DEV_LOG_DATABASE_URL:-postgresql://devlog:devlog_local_dev@localhost:5433/dev_log}</string>
<key>DEV_LOG_PUBLIC_URL</key><string>${DEV_LOG_PUBLIC_URL:-}</string>
</dict>
<key>StartInterval</key><integer>120</integer>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/dev-log-watchdog.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/dev-log-watchdog.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Wächter installiert: $PLIST (Log: ~/Library/Logs/dev-log-watchdog.log)"
