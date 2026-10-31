# Client-IP hinter nginx nicht fälschbar (2026-10-27)

Auftrag `19a8fa9f-dd4a-4250-acc7-311deeb73706` (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026.

## Problem

`DEV_LOG_TRUST_PROXY=uniquelocal` vertraute allen privaten Adressen. nginx hängte seine Sicht nur an ein vom Client
mitgeschicktes `X-Forwarded-For` an und reichte `X-Forwarded-Proto` ungeprüft durch. Beim Direktzugriff auf
`127.0.0.1:3100` galt so eine gefälschte Adresse als Client-IP (`request.ip`). Die Fehlversuchs-Sperre
(`attemptKey(request.ip, …)` in `src/api/auth.ts`) ließ sich mit wechselnden IPs umgehen. Über Caddy trat das nicht
auf, weil Caddy den Header ersetzt.

## Umsetzung

- **Zwei Eingänge in nginx** (`deploy/frontend/nginx.conf`), gleiche Routen über `deploy/frontend/app-locations.conf`:
  - **8080** (Host-Port `127.0.0.1:3100`): `X-Forwarded-For` ist die Socket-Adresse, das Protokoll `$scheme`. Ein
    mitgeschickter Header des Clients wird ersetzt.
  - **8081** (nicht veröffentlicht, nur Caddy): `set_real_ip_from` für private Netze, `real_ip_header X-Forwarded-For`,
    `real_ip_recursive off` (nur der letzte Eintrag zählt, auch bei Listen oder mehreren Header-Zeilen).
    `X-Forwarded-Proto` gilt nur, wenn es genau `https` ist.
- **Warum zwei Ports statt Prüfung nach Absender:** Direktzugriffe über den Host-Port kommen vom Gateway desselben
  Docker-Netzes wie Caddy. Ein `set_real_ip_from` für dieses Netz würde auch gefälschte Header glauben.
- **Caddy** (`deploy/Caddyfile`) leitet an `frontend:8081` statt `8080` weiter. Bei 8080 sähen alle Nutzer die Adresse
  von Caddy und teilten sich eine Sperr-Adresse.
- **Backend:** `DEV_LOG_TRUST_PROXY` ist in `docker-compose.yml` jetzt `"1"` (genau ein Hop, nginx).
  `trustProxySetting` in `src/api/security.ts` akzeptiert `1` und gibt die Zahl `1` zurück (Express liest den String
  `"1"` sonst als Adressliste). Größere Hop-Zahlen, `true` und `*` bleiben verboten. Die Warnung in `src/api/app.ts`
  nennt `1` als erlaubten Wert.
- `deploy/frontend/Dockerfile` kopiert `app-locations.conf` nach `/etc/nginx/` (außerhalb von `conf.d`) und gibt 8080
  und 8081 frei.

## Geänderte Dateien

- `deploy/frontend/nginx.conf`, `deploy/frontend/app-locations.conf` (neu), `deploy/frontend/Dockerfile`
- `deploy/Caddyfile`, `docker-compose.yml`
- `src/api/security.ts`, `src/api/app.ts`
- `src/api/client-ip.test.ts` (neu), `src/api/security.test.ts`
- `docs/installation.md` (Abschnitt „Client-IP hinter nginx“, Störungstabelle), `docs/laufzeit.md`,
  `docs/benutzerhandbuch-dashboard-agents.md`

## Worauf ist zu achten

- **Ausrollen:** `frontend` und `https` neu bauen bzw. starten, sonst gilt die alte Konfiguration. Caddy muss auf
  `frontend:8081` zeigen, das Backend auf `DEV_LOG_TRUST_PROXY=1`.
- **Nicht geprüft:** Die nginx-Konfiguration wurde weder mit `nginx -t` noch im Live-Stack getestet. Nach dem
  Ausrollen einen Login über Caddy und einen Direktzugriff mit gefälschtem `X-Forwarded-For` prüfen.
- `DEV_LOG_TRUST_PROXY=1` ist nur sicher, solange das Backend ausschließlich hinter nginx erreichbar ist.
- Das Agent-Projekt `aideation-agent` hat keine Host-Ports und blieb unverändert (`ports.aideation-agent.yml`).

## Tests

- `src/api/client-ip.test.ts`: gefälschtes `X-Forwarded-For` beim Direktzugriff ändert `request.ip` nicht,
  Zugriff über Caddy behält die echte Client-IP, gefälschtes `X-Forwarded-Proto`, `X-Real-IP`, Listen und mehrere
  Header-Zeilen, Fehlversuchs-Sperre trotz wechselnder IPs.
- `src/api/security.test.ts`: `trustProxySetting` mit `1`.
- Ausführen über `npm test`.
