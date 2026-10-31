# Benutzerhandbuch: Wächter erhält die öffentliche Adresse nach Einrichtung mit Domain

Auftrag d78bcb67 (Bugfix). Gilt für die Einrichtung über den Assistenten im Server-Setup.

## Was sich ändert

Richtet der Assistent den Server mit einer eigenen Domain ein, bekommt der Wächter die öffentliche HTTPS-Adresse jetzt tatsächlich mit. Vorher blieb sie leer. Der Wächter prüfte dann die HTTPS-Adresse nie und meldete auch kein abgelaufenes Zertifikat.

## Bedingungen

| Situation | Ergebnis |
|---|---|
| Einrichtung mit Domain, z. B. `devlog.example.com` | `watchdog.env` enthält `DEV_LOG_PUBLIC_URL=https://devlog.example.com`. Der Wächter prüft `https://devlog.example.com/health`. |
| Einrichtung ohne Domain | Es wird keine Adresse übergeben. Ein Wert aus einer früheren Sitzung wird nicht mehr weitergegeben. Der Wächter prüft dann keinen HTTPS-Zugang. |
| Domain nachträglich entfernt | Bei der nächsten Einrichtung ohne Domain entfällt die Adresse. Ob eine bereits vorhandene `watchdog.env` dabei geleert wird, ist nicht geprüft; siehe unten. |

Die Adresse wird immer als `https://` gespeichert. Ein abgelaufenes Zertifikat führt dazu, dass der Erreichbarkeitstest fehlschlägt. Der Wächter meldet dann „HTTPS-Zugang … gestört“.

## Schritte zur Kontrolle

1. Einrichtung mit Domain im Assistenten durchlaufen.
2. In der Konfigurationsdatei `watchdog.env` nachsehen: Die Zeile `DEV_LOG_PUBLIC_URL=https://<domain>` muss stehen.
3. Die Wächter-Plist lädt diese Datei per `--env-file`. Die Plist selbst enthält keine Variablen.

## Bestehende Installationen

Eine Installation, die mit Domain eingerichtet wurde, hat die Adresse bisher nicht erhalten. Sie sollte einmal erneut eingerichtet bzw. `install-watchdog.sh` erneut ausgeführt werden. Danach gilt die Kontrolle aus Schritt 2. Ob das bei Ihrer Installation nötig ist, prüfen Sie mit dieser Kontrolle.

## Grenzen

- Ohne Domain prüft der Wächter den HTTPS-Zugang nicht. Das ist beabsichtigt.
- Der Wächter erkennt ein abgelaufenes Zertifikat nur über den fehlgeschlagenen Erreichbarkeitstest, nicht über das Ablaufdatum selbst.
- Die Tests `src/core/env-file.test.ts` und `src/setup/install-scripts.test.ts` sind laut Entwickler nicht gelaufen. Der Test in `install-scripts.test.ts` läuft nur auf macOS.

## Printscreens

Keine. Die Änderung betrifft die Einrichtung über Skripte und die Konfigurationsdatei, nicht die Oberfläche. Eine Aufnahme der Konfigurationsdatei wäre nur mit echter Domain sinnvoll und enthielte Geheimnisse; deshalb wurde keine erstellt.

## Verwandte Dokumente

- `docs/assistent-installiert-waechter-mit-public-url-2026-10-29.md` (technische Beschreibung)
- `docs/benutzerhandbuch-skripte-env-statt-standardpasswort.md` (Konfigurationswerte der Skripte)
