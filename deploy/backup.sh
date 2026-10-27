#!/bin/sh
# Tägliches Backup der AIdeation-Datenbank nach ./backups (pg_dump im Custom-Format, komprimiert).
# Läuft als eigener Container; sichert, sobald das letzte Backup älter als 23 Stunden ist. Nur nach einem
# erfolgreichen Dump wird rotiert: Die neuesten BACKUP_MIN_KEEP (Standard 7) aideation-*.dump bleiben immer,
# ältere werden gelöscht, sobald sie älter als BACKUP_KEEP_DAYS Tage sind. Andere Dateien bleiben unberührt.
#
# Liegt ./backups auf einem externen Laufwerk, zeigt die Einbindung nach einem Ausfall ins Leere
# („Not a directory“). Dann beendet sich das Skript mit Fehler, damit Docker den Container neu startet und
# die Einbindung neu aufbaut; der Wächter (watchdog) startet ihn notfalls wieder.
#
# Für Tests: BACKUP_DIR statt /backups, BACKUP_ONCE=1 für genau einen Durchlauf.
set -u
# Dumps enthalten die ganze Datenbank: nur für den Besitzer lesbar.
umask 077
DIR="${BACKUP_DIR:-/backups}"

# Positive ganze Zahl oder Standard – ein ungültiger Wert darf nie „alles löschen“ bedeuten.
number() {
  case "$1" in
    '' | *[!0-9]*) echo "$2" ;;
    *) if [ "$1" -ge 1 ] 2>/dev/null; then echo "$1"; else echo "$2"; fi ;;
  esac
}
KEEP_DAYS="$(number "${BACKUP_KEEP_DAYS:-}" 14)"
MIN_KEEP="$(number "${BACKUP_MIN_KEEP:-}" 7)"

# Der Zeitstempel im Namen sortiert zuverlässiger als mtime (die sich beim Kopieren ändert).
rotate() {
  ls -1 "$DIR" 2>/dev/null | grep -E '^aideation-[0-9]{8}-[0-9]{6}\.dump$' | sort -r | tail -n "+$((MIN_KEEP + 1))" |
    while read -r name; do
      if [ -n "$(find "$DIR/$name" -mtime "+$KEEP_DAYS" 2>/dev/null)" ]; then
        rm -f "$DIR/$name" && echo "$(date -Iseconds) Altes Backup gelöscht: $name"
      fi
    done
}

while true; do
  if ! touch "$DIR/.write-test" 2>/dev/null; then
    echo "$(date -Iseconds) Backup-Ordner nicht beschreibbar (Laufwerk getrennt?) – Neustart des Containers" >&2
    exit 1
  fi
  rm -f "$DIR/.write-test" 2>/dev/null || true
  if [ -z "$(find "$DIR" -maxdepth 1 -name 'aideation-*.dump' -mmin -1380 2>/dev/null)" ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    if pg_dump -Fc -d aideation -f "$DIR/.aideation-$stamp.tmp"; then
      if mv "$DIR/.aideation-$stamp.tmp" "$DIR/aideation-$stamp.dump"; then
        echo "$(date -Iseconds) Backup geschrieben: aideation-$stamp.dump"
        rotate
      else
        echo "$(date -Iseconds) Backup konnte nicht umbenannt werden – keine Rotation" >&2
      fi
    else
      rm -f "$DIR/.aideation-$stamp.tmp" 2>/dev/null || true
      echo "$(date -Iseconds) Backup fehlgeschlagen – keine Rotation" >&2
    fi
  fi
  [ "${BACKUP_ONCE:-}" = 1 ] && exit 0
  sleep 3600
done
