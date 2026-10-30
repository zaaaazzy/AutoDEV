# Benutzerhandbuch: TOTP- und Push-Schlüssel verschlüsselt speichern

Stand: 2026-10-27 · Auftrag `d041ed39` · Sprint 23

## Was sich für dich ändert

Die Zwei-Faktor-Schlüssel (TOTP) und der private Push-Schlüssel (VAPID) liegen in der Datenbank nicht mehr im Klartext.
Sie werden mit `DEV_LOG_SECRET_KEY` verschlüsselt (AES-256-GCM, Präfix `enc:v1:`). Wer nur einen Datenbank-Dump hat,
kann damit weder gültige 2FA-Codes erzeugen noch Push-Nachrichten als AIdeation senden.

Im Alltag ändert sich für Anmeldung, Oberfläche und Push-Benachrichtigungen nichts. Neu ist nur, dass der Server beim
Start bestehende Werte einmal umstellt und dabei Bedingungen prüft (siehe unten).

**Printscreens: keine.** Die Änderung betrifft nur Datenbank, Start und Wächter-Installation. Die Oberfläche bleibt
gleich. Die Ausgaben im Terminal und in den Logs stehen deshalb im Wortlaut unten.

## Was verschlüsselt ist

| Wert | Ort | Verschlüsselt seit |
|---|---|---|
| TOTP-Schlüssel der Benutzer (aktiv und ausstehend) | `users.totp_secret`, `users.totp_pending` | diesen Auftrag (bereits vorher umgestellt) |
| TOTP-Schlüssel des Systemadministrators | `app_settings.auth_totp_secret`, `auth_totp_pending` | diesen Auftrag (bereits vorher umgestellt) |
| Privater VAPID-Schlüssel für Push | `app_settings.push_vapid_keys` | dieser Auftrag |
| Datenbank-Zugänge der Projekte | `projects.database_url` | früher |

Nicht verschlüsselt bleiben Aufträge, Bugs, Doku, Agent-Ausgaben, Benutzernamen, Passwort-Hashes und Push-Abos. Behandle
Backups deshalb wie die Datenbank selbst.

## Bedingungen

- **`DEV_LOG_SECRET_KEY` ist Pflicht, sobald TOTP- oder Push-Schlüssel gespeichert sind.** Er muss mindestens
  16 Zeichen haben. Ohne ihn startet der Dienst nicht.
- **Derselbe Schlüssel auf allen Rechnern.** Er steht in `.env` (Server), `worker.env` (Worker) und `watchdog.env`
  (Wächter). Ein anderer Wert lässt die Schlüssel nicht lesen.
- **Der Schlüssel bleibt beim Umstellen gleich.** Die Push-Abos der Geräte gelten weiter. Die TOTP-Codes der
  Authenticator-App ebenfalls.
- **Der Schlüssel darf nicht im Backup liegen.** Liegt er in derselben Sicherung wie die Datenbank (etwa eine Kopie der
  `.env` in `./backups`), schützt die Verschlüsselung nichts. Bewahre ihn z. B. im Passwortmanager auf.
- **Die Umstellung ist einmalig.** Ein Wert, der schon mit `enc:v1:` beginnt, bleibt unverändert. Ein erneuter Start
  ändert nichts.

## Ablauf beim Start

1. Der Server liest alle TOTP-Werte. Klartext wird mit `DEV_LOG_SECRET_KEY` neu geschrieben. Das Terminal meldet dann
   z. B.:
   ```
   2 Zwei-Faktor-Schlüssel verschlüsselt.
   ```
2. Danach prüft der Server den VAPID-Schlüssel. Ist er noch Klartext, wird er verschlüsselt. Das Terminal meldet:
   ```
   Push-Schlüssel verschlüsselt.
   ```
3. Ist der Wert schon verschlüsselt, bleibt er still.
4. Gelöscht wird dabei nichts. Der Schlüssel selbst ändert sich nicht.

Der Worker liest den Push-Schlüssel ebenfalls. Startet er vor dem Server, kann er den Klartext noch lesen. Die Umstellung
erledigt dann der Server beim nächsten Start.

## Fehlermeldungen und Behebung

| Meldung | Ursache | Was tun |
|---|---|---|
| „Zwei-Faktor-Schlüssel brauchen DEV_LOG_SECRET_KEY“ | Es gibt TOTP-Schlüssel, aber der Schlüssel fehlt in `.env` | Den bisherigen `DEV_LOG_SECRET_KEY` in `.env` eintragen und neu starten |
| „Push-Schlüssel brauchen DEV_LOG_SECRET_KEY“ | Wie oben, für den VAPID-Schlüssel | Wie oben. Gelöscht wird nichts |
| „Zwei-Faktor-Schlüssel lassen sich mit dem gesetzten DEV_LOG_SECRET_KEY nicht lesen.“ | Der Schlüssel in `.env` passt nicht zu den gespeicherten Werten | Den Schlüssel aus der Zeit der Verschlüsselung eintragen. Nicht raten und nicht neu erzeugen |
| „Push-Schlüssel lassen sich mit dem gesetzten DEV_LOG_SECRET_KEY nicht lesen.“ | Wie oben, für den VAPID-Schlüssel | Wie oben |
| Wächter schickt nach dem Update keine Push-Nachricht | `DEV_LOG_SECRET_KEY` fehlt in `watchdog.env` | `DEV_LOG_SECRET_KEY=… ./scripts/install-watchdog.sh` einmal erneut ausführen |

Wer den Schlüssel verloren hat, muss die Projektzugänge neu eintragen, den zweiten Faktor neu einrichten und Push auf
den Geräten neu aktivieren (siehe [README](../../README.md), Abschnitt Konfiguration).

## Einmalige Schritte bei bestehender Installation

1. In `.env` `DEV_LOG_SECRET_KEY` setzen, falls noch nicht geschehen. Der Wert muss der bisherige sein.
2. Server neu starten. Die Meldungen aus „Ablauf beim Start“ erscheinen.
3. Wächter neu installieren, damit `watchdog.env` den Schlüssel enthält:
   `DEV_LOG_SECRET_KEY=… ./scripts/install-watchdog.sh`.
   Bis dahin nutzt der Wächter die Schlüssel aus seiner Zustandsdatei.
4. Worker: `worker.env` prüfen, ob der Schlüssel dort steht.

## Noch offen

- **Klartext im Wächter:** Die Datei `~/Library/Application Support/DevLog/watchdog.json` (Rechte 600) enthält den
  privaten VAPID-Schlüssel weiter im Klartext. Damit meldet der Wächter auch bei ausgefallener Datenbank. Die Datei
  liegt nicht im Datenbank-Backup. Das ist bewusst so. Bei Bedarf braucht es einen eigenen Auftrag.
- **Formatierung:** `npm run format:check` meldete `src/core/push.ts` und `src/api/push.test.ts`. Ob das schon auf `main`
  so war, ist nicht geprüft.
- **Tests:** Ich habe weder `npm test` noch die Umstellung auf einer echten Datenbank ausgeführt. Die Beschreibung stammt
  aus dem Code und aus der Auftragsdoku. Vor dem Merge sollen die Tests in `src/core/push.test.ts` und
  `src/api/push.test.ts` laufen.

## Verwandte Dokumente

- [Entwicklerdoku zur Änderung](totp-und-vapid-verschluesselt-2026-10-27.md)
- [Installation, Abschnitt Wiederherstellen](../installation.md)
- [Benutzerhandbuch Restore-Skript und Probe](benutzerhandbuch-restore-skript-und-probe.md)
