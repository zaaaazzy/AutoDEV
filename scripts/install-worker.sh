#!/bin/bash
# Installiert den AIdeation-Worker als macOS LaunchAgent (Autostart, Neustart bei Absturz).
# Der Worker bedient alle im AIdeation registrierten Projekte, jeweils im eigenen Projektordner.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.aideation.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(dirname "$(command -v node)")"
# launchd startet mit minimalem PATH; externe Agent-CLIs (claude, copilot, gemini) liegen oft in
# ~/.local/bin oder /opt/homebrew/bin. Deshalb den PATH der aufrufenden Shell übernehmen.
WORKER_PATH="$NODE_BIN:$HOME/.local/bin:/opt/homebrew/bin:$PATH:/usr/local/bin:/usr/bin:/bin"
for cli in claude copilot gemini; do
  if command -v "$cli" >/dev/null 2>&1; then echo "Gefunden: $cli → $(command -v "$cli")"; fi
done
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>WorkingDirectory</key><string>$ROOT</string>
<key>ProgramArguments</key><array>
<string>$NODE_BIN/npm</string><string>run</string><string>worker</string></array>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>$WORKER_PATH</string>
<key>DEV_LOG_DATABASE_URL</key><string>${DEV_LOG_DATABASE_URL:-postgresql://devlog:devlog_local_dev@localhost:5433/aideation}</string>
<key>DEV_LOG_OLLAMA_MODEL</key><string>${DEV_LOG_OLLAMA_MODEL:-qwen3.5:9b}</string>
<key>DEV_LOG_SECRET_KEY</key><string>${DEV_LOG_SECRET_KEY:-}</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/aideation-worker.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/aideation-worker.log</string>
</dict></plist>
P
# Frühere Bezeichnung (Dev Log) abräumen.
launchctl bootout "gui/$(id -u)/com.devlog.worker" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.devlog.worker.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Worker installiert: $PLIST (Log: ~/Library/Logs/aideation-worker.log)"
