# Benutzerhandbuch: Client-IP hinter nginx nicht fälschbar

Dieses Kapitel beschreibt, was sich bei der Anmeldung geändert hat, wenn AIdeation über Caddy oder den direkten
Port läuft (Auftrag 19a8fa9f, Sprint 23). Die Technik steht in
[Client-IP hinter nginx nicht fälschbar](client-ip-hinter-nginx-nicht-faelschbar-2026-10-27.md) und in
`installation.md`, Abschnitt „Client-IP hinter nginx“.

## 1. Was sich für dich ändert

- **Die Fehlversuch-Bremse zählt je echtem Gerät.** Hinter Caddy sieht AIdeation wieder die Adresse des Geräts, das
  sich anmeldet, und nicht die des Proxys. Ein Gerät, das sich vertippt, bremst also nur sich selbst.
- **Ein gefälschter Header hilft nicht mehr.** Wer AIdeation direkt über `127.0.0.1:3100` aufruft und selbst ein
  `X-Forwarded-For` mitschickt, bekommt damit keine andere Adresse. Die Bremse lässt sich nicht mehr umgehen, indem
  man bei jedem Versuch eine andere IP angibt.
- **Das Protokoll wird nur aus Caddy übernommen.** Nur ein genau mitgeschicktes `X-Forwarded-Proto: https` aus Caddy
  zählt als https. Alles andere gilt als http.

Die Oberfläche ändert sich nicht. Die Anmeldemaske, die Meldungen und die Wartezeiten bleiben gleich.

## 2. Wo es gilt

**Gilt für:** die Anmeldung über Caddy (`https://` auf der eigenen Domain) und über den direkten Zugriff
`http://127.0.0.1:3100`.

**Gilt nicht für:**

- Bestehende Sitzungen. Sie bleiben, wie sie waren.
- Die Wartezeiten selbst (1 Minute, verdoppelt bis höchstens 15 Minuten, siehe Abschnitt 6.2 in
  [Dashboard und Agents](benutzerhandbuch-dashboard-agents.md)). Daran ändert sich nichts.
- Agents und Worker. Sie sprechen die API nicht über nginx an.

## 3. Was du beim direkten Zugriff beachten solltest

Beim direkten Zugriff sieht das Backend nicht die Adresse deines Geräts, sondern nur die Adresse, die nginx ihm
weitergibt. Je nach Docker-Setup ist das die Adresse des Docker-Gateways. Dann teilen sich alle, die direkt über
`127.0.0.1:3100` zugreifen, eine Bremse. Wer über Caddy arbeitet, ist davon nicht betroffen.

Das ist die Folge der Absicherung, nicht ein neuer Fehler: Die Adresse, die beim Direktzugriff gilt, lässt sich nicht
mehr vom Client wählen.

## 4. Bedingungen für die Umsetzung

Die Änderung wirkt erst nach einem Neustart der Dienste `frontend` und `https`. Ohne den Neubau gilt die alte
Konfiguration weiter, und dann bleibt die Bremse für alle Geräte gemeinsam.

| Dienst | Was passiert | Warum |
|---|---|---|
| `frontend` (nginx) | Neu bauen und starten | Die neue Konfiguration mit zwei Eingängen (8080 direkt, 8081 nur für Caddy) liegt im Image |
| `https` (Caddy) | Neu bauen und starten | Caddy leitet jetzt an `frontend:8081` weiter, nicht mehr an 8080 |
| `dev-log` (Backend) | Neu starten | `DEV_LOG_TRUST_PROXY` steht jetzt auf `1` (genau ein Proxy davor) |

`DEV_LOG_TRUST_PROXY` ist in `docker-compose.yml` fest auf `"1"` gesetzt. Eine Eintragung in der `.env` ändert daran
nichts.

## 5. Meldungen und was du tust

| Was du siehst | Bedeutung | Was du tust |
|---|---|---|
| „Zu viele Fehlversuche …“ | Die Bremse greift für dein Gerät. Die Meldung nennt die Wartezeit. | Warten und dann mit dem richtigen Passwort anmelden. |
| Alle Geräte werden gemeinsam gebremst | Das Backend sieht nur die Proxy-Adresse. Meist heißt das: Caddy leitet noch an 8080 weiter oder `DEV_LOG_TRUST_PROXY` ist falsch. | Prüfen, ob Caddy `frontend:8081` ansteuert, und die Dienste neu bauen (Abschnitt 4). |
| Im Log von `dev-log`: „DEV_LOG_TRUST_PROXY ungültig …“ | Der Wert ist nicht erlaubt. Die Client-IP wird dann ignoriert. | In der `.env` `DEV_LOG_TRUST_PROXY` entfernen oder auf `1` setzen und neu starten. |

## 6. Prüfliste nach dem Ausrollen

Diese Punkte sind noch **nicht geprüft**. Sie sollten nach dem Ausrollen einmal durchgegangen werden:

1. Anmeldung über Caddy funktioniert, und die Seite lädt ohne Fehler.
2. Bei einem falschen Passwort über Caddy wird die Fehlversuchszählung der eigenen Adresse zugeordnet, nicht einer
   gemeinsamen. Nach zehn Fehlversuchen von einem zweiten Gerät aus bleibt dieses frei.
3. Beim direkten Zugriff mit einem gefälschten `X-Forwarded-For: 1.2.3.4` ändert sich die Sperr-Adresse nicht.
4. `nginx -t` für `deploy/frontend/nginx.conf` ist im Container nicht gelaufen.

## 7. Grenzen

- **Keine Printscreens.** Die Änderung hat keine Oberflächenänderung. In dieser Sitzung lief weder ein Browser noch die
  App, deshalb gibt es keine Bilder.
- **Tests nicht bestätigt.** `src/api/client-ip.test.ts` und `src/api/security.test.ts` sind im Entwickler-Commit
  enthalten. Ob sie laufen und ob sie den Fehler vor dem Fix tatsächlich zeigen, ist in diesem Kapitel nicht belegt.
- **Nicht im Live-Stack getestet.** Der Caddy-Weg und der Direktzugriff sind nur gelesen, nicht gestartet worden.
