#!/bin/sh
# Tägliches Backup der Dev-Log-Datenbank nach ./backups (pg_dump im Custom-Format, komprimiert).
# Läuft als eigener Container; sichert, sobald das letzte Backup älter als 23 Stunden ist, und
# löscht Backups, die älter als BACKUP_KEEP_DAYS Tage sind.
set -eu
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
while true; do
  if [ -z "$(find /backups -maxdepth 1 -name 'dev_log-*.dump' -mmin -1380 2>/dev/null)" ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    if pg_dump -Fc -d dev_log -f "/backups/.dev_log-$stamp.tmp"; then
      mv "/backups/.dev_log-$stamp.tmp" "/backups/dev_log-$stamp.dump"
      echo "$(date -Iseconds) Backup geschrieben: dev_log-$stamp.dump"
    else
      rm -f "/backups/.dev_log-$stamp.tmp"
      echo "$(date -Iseconds) Backup fehlgeschlagen" >&2
    fi
    find /backups -maxdepth 1 -name 'dev_log-*.dump' -mtime "+$KEEP_DAYS" -delete
  fi
  sleep 3600
done
