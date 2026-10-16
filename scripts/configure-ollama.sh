#!/bin/bash
# Setzt Ollama-Einstellungen für die macOS-App (jetzt und bei jedem Login) und startet Ollama neu.
# Werte lassen sich per Umgebungsvariable überschreiben, z. B. OLLAMA_MAX_LOADED_MODELS=2 ./scripts/configure-ollama.sh
set -euo pipefail
LABEL="com.devlog.ollama-env"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:--1}"
FLASH="${OLLAMA_FLASH_ATTENTION:-1}"
KV="${OLLAMA_KV_CACHE_TYPE:-q8_0}"
MAX_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array>
<string>/bin/sh</string><string>-c</string>
<string>launchctl setenv OLLAMA_KEEP_ALIVE $KEEP_ALIVE; launchctl setenv OLLAMA_FLASH_ATTENTION $FLASH; launchctl setenv OLLAMA_KV_CACHE_TYPE $KV; launchctl setenv OLLAMA_MAX_LOADED_MODELS $MAX_MODELS</string>
</array>
<key>RunAtLoad</key><true/>
</dict></plist>
P

launchctl setenv OLLAMA_KEEP_ALIVE "$KEEP_ALIVE"
launchctl setenv OLLAMA_FLASH_ATTENTION "$FLASH"
launchctl setenv OLLAMA_KV_CACHE_TYPE "$KV"
launchctl setenv OLLAMA_MAX_LOADED_MODELS "$MAX_MODELS"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

osascript -e 'quit app "Ollama"' 2>/dev/null || true
for _ in $(seq 1 20); do pgrep -x Ollama >/dev/null || break; sleep 1; done
open -a Ollama
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/version >/dev/null && break; sleep 1; done
echo "Ollama neu gestartet: KEEP_ALIVE=$KEEP_ALIVE FLASH_ATTENTION=$FLASH KV_CACHE_TYPE=$KV MAX_LOADED_MODELS=$MAX_MODELS"
