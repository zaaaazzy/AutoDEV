#!/bin/sh
# Tägliches Backup der AIdeation-Datenbank nach ./backups (pg_dump im Custom-Format, komprimiert).
# Läuft als eigener Container; sichert, sobald das letzte Backup älter als 23 Stunden ist, und
# löscht Backups, die älter als BACKUP_KEEP_DAYS Tage sind.
#
# Liegt ./backups auf einem externen Laufwerk, zeigt die Einbindung nach einem Ausfall ins Leere
# („Not a directory“). Dann beendet sich das Skript mit Fehler, damit Docker den Container neu startet und
# die Einbindung neu aufbaut; der Wächter (watchdog) startet ihn notfalls wieder.
set -u
# Dumps enthalten die ganze Datenbank: nur für den Besitzer lesbar.
umask 077
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
while true; do
  if ! touch /backups/.write-test 2>/dev/null; then
    echo "$(date -Iseconds) Backup-Ordner nicht beschreibbar (Laufwerk getrennt?) – Neustart des Containers" >&2
    exit 1
  fi
  rm -f /backups/.write-test 2>/dev/null || true
  if [ -z "$(find /backups -maxdepth 1 -name 'aideation-*.dump' -mmin -1380 2>/dev/null)" ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    if pg_dump -Fc -d aideation -f "/backups/.aideation-$stamp.tmp"; then
      mv "/backups/.aideation-$stamp.tmp" "/backups/aideation-$stamp.dump" || echo "$(date -Iseconds) Backup konnte nicht umbenannt werden" >&2
      echo "$(date -Iseconds) Backup geschrieben: aideation-$stamp.dump"
    else
      rm -f "/backups/.aideation-$stamp.tmp" 2>/dev/null || true
      echo "$(date -Iseconds) Backup fehlgeschlagen" >&2
    fi
    find /backups -maxdepth 1 -name '*.dump' -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true
  fi
  sleep 3600
done
