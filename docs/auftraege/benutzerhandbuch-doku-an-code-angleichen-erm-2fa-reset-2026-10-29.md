# Benutzerhandbuch: Zwei-Faktor zurücksetzen, `DEV_LOG_BIND` entfernt

Stand: 2026-10-29 · Auftrag `59c9e471` · Sprint 28

## Was sich für dich ändert

Zwei Dinge sind neu beschrieben bzw. verändert. Die Oberfläche selbst ändert sich nicht.

1. **Zwei-Faktor zurücksetzen (benannte Benutzer).** Ein Administrator kann den zweiten Faktor eines Benutzers über
   die Oberfläche zurücksetzen. Bisher stand in der README nur der Weg für den Systemadministrator. Die Anleitung
   nennt jetzt beide Fälle.
2. **`DEV_LOG_BIND` gibt es nicht mehr.** Die Variable hatte keine Wirkung. Sie stand in `.env` als Schalter für die
   Erreichbarkeit, hat das Verhalten des Dienstes aber nie geändert. Die Warnung beim Start ist entfallen. Die
   Erreichbarkeit steuert allein `DEV_LOG_HOST`.

Die technische Referenz `docs/erm.md` (Tabellen und Status-Werte) und die Angaben in `docs/wartungs-jobs.md` und
`docs/laufzeit.md` sind nachgezogen. Das sind Entwicklerdokumente und keine Bedienungsanleitung.

**Printscreens: keine.** Die App mit Datenbank und Browser ist für diesen Auftrag nicht gestartet worden. Die Bedienung
unten ist aus dem Code abgeleitet (Schaltfläche in `users-settings.component.html`, Endpunkt in `src/api/users.ts`).
Printscreens können nachgereicht werden, sobald die Browser-Prüfung läuft.

## Zwei-Faktor zurücksetzen

**Wo:** Einstellungen → Alle Projekte → Benutzer & Rollen. Dort steht bei jedem Benutzer, der den zweiten Faktor aktiv
hat, der Zusatz „· Zwei-Faktor“. Neben „Speichern“ erscheint dann die Schaltfläche **Zwei-Faktor zurücksetzen**.

**Bedingungen:**

- **Nur Administratoren.** Der Endpunkt `POST /api/users/<id>/totp/reset` verlangt die Rolle „admin“ im Mandanten
  „admin“. Andere Benutzer sehen die Schaltfläche, erreichen aber nichts damit.
- **Nur bei aktivem zweiten Faktor.** Die Schaltfläche erscheint nur, wenn der Benutzer schon einen Schlüssel hat.
  Ausstehende Einrichtungen werden dabei ebenfalls verworfen.
- **Der Administrator selbst fehlt in dieser Liste.** Der Systemadministrator (Anmeldung aus der `.env`) hat keinen
  Eintrag mit Schaltfläche. Sein Schlüssel liegt in `app_settings.auth_totp_secret`. Zurücksetzen geht nur über die
  Datenbank, danach ist ein Neustart nötig, weil der Dienst den Wert nur beim Start liest:

  ```
  docker compose exec db psql -U devlog aideation -c "DELETE FROM app_settings WHERE key IN ('auth_totp_secret', 'auth_totp_pending')"
  docker compose restart dev-log
  ```

- **Ohne Administrator-Zugang.** Wer keinen Administrator erreicht, setzt den Schlüssel eines benannten Benutzers über
  die Datenbank zurück. Ein Neustart ist dafür nicht nötig:

  ```
  docker compose exec db psql -U devlog aideation -c "UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE lower(username) = lower('<name>')"
  ```

- **Danach** ist der zweite Faktor für diesen Benutzer ausgeschaltet. Der Benutzer kann ihn unter Einstellungen →
  Sicherheit neu einrichten (laut `README.md`). Da kein zweiter Faktor mehr aktiv ist, reicht dafür das aktuelle Passwort.
  Der alte Code aus der Authenticator-App funktioniert nicht mehr.

## `DEV_LOG_BIND` entfernen

**Was du tun musst:** Steht `DEV_LOG_BIND` noch in der `.env` des Live-Systems, kannst du die Zeile löschen. Sie ist
harmlos und wirkt nicht. Die `.env` ist für Agents gesperrt, deshalb ist diese Änderung Sache des Betreibers.

**Was stattdessen gilt:**

| Wunsch | Einstellung |
|---|---|
| Nur auf diesem Rechner erreichbar (Start ohne Container) | Standard, keine Angabe nötig (`127.0.0.1`) |
| Im Container hinter nginx oder Caddy | `DEV_LOG_HOST=0.0.0.0` (ist in `docker-compose.yml` gesetzt) |

**Bedingungen:**

- Die Erreichbarkeit von außen regeln Port-Veröffentlichung in Docker, die Firewall und der HTTPS-Proxy. Eine
  Einstellung in der `.env` allein schützt nicht und öffnet nicht.
- Es gibt keine Warnung mehr beim Start, wenn ein Netz-Bind gesetzt ist. Wer den Dienst ins Netz stellt, prüft das
  selbst (siehe `README.md`, Abschnitt Betrieb).

## Offen

| Stand | Punkt | Hinweis |
|---|---|---|
| offen, Betreiber | `DEV_LOG_BIND` in der Live-`.env` | Harmlos. Zeile löschen. |
| offen | Browser-Prüfung der Schaltfläche „Zwei-Faktor zurücksetzen“ | Noch nicht durchgeführt. |
| offen | Printscreens | Erst nach der Browser-Prüfung. |
