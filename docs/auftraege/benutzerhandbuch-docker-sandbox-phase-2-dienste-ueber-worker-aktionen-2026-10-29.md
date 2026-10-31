# Benutzerhandbuch: Dienste über Worker-Aktionen (Docker-Sandbox Phase 2)

Dieses Kapitel beschreibt die neuen Dienst-Aktionen aus Auftrag 2cb9201f. Agents verwalten Dienste eines Projekts nicht mehr selbst per Shell (`docker compose`, `launchctl`). Sie fordern feste Aktionen an, und der Worker prüft und führt sie aus. Für dich ändert sich dadurch im Alltag wenig: Der Assistent kann Dienste weiterhin neu starten und Logs lesen. Neu ist, dass dafür eine Gruppe „Projekt-Dienste“ gilt und dass Projekte mit altem launchd-Dienst einen Hinweis bekommen.

> **Printscreens:** keine. In dieser Sitzung wurde die App nicht gestartet, und es gab keinen Browser-Lauf. Die Beschreibung stammt aus dem Quelltext des Auftrags-Branches (`src/agent/service-request.ts`, `src/agent/service-actions.ts`, `src/agent/permission-rules.ts`, `src/setup/setup-jobs.ts`, `frontend/src/app/features/projects/project-wizard.component.html`) und aus `docs/docker-sandbox-phase-2-dienste-ueber-worker-aktionen-2026-10-29.md`. Abschnitt 10 nennt die Aufnahmen, die noch fehlen.
>
> **Stand:** Der Code liegt auf dem Branch `auftrag/2cb9201f-docker-sandbox-phase-2-dienste-u`. Die Tests des Entwicklers (`npm test`, `npm run typecheck`, `npm run test:e2e`) hat dieses Kapitel nicht selbst ausgeführt. Die Aktionen `services.status` und `services.restart` sind mit echtem Docker noch nicht geprüft.

---

## 1. Was sich ändert

Bisher durfte der Assistent Compose-Befehle wie `docker compose restart` selbst ausführen, und die Gruppe „Docker-Dienste“ oder macOS-Befehle wie `launchctl kickstart` gaben ihm dafür die Rechte. Das hatte zwei Nachteile:

- Ein Agent mit Docker-Zugriff hätte faktisch Root auf dem Rechner (über den Docker-Socket).
- Die macOS-Befehle waren nur auf macOS sinnvoll.

Jetzt gilt:

- Der Agent fordert eine **feste Aktion** an, zum Beispiel „Dienst `api` neu starten“.
- Der **Worker** prüft die Anfrage und führt den Befehl selbst aus.
- Das Ergebnis (maskiert und gekürzt) kommt als Abschnitt **„Dienst-Aktionen“** in die Antwort des Assistenten.
- `docker`, `docker compose` und `launchctl` stehen in keiner Rechte-Gruppe mehr. Der Agent kann sie nicht mehr über die Shell ausführen.

## 2. Die fünf Aktionen

| Aktion | Was sie tut | Wer darf sie |
|---|---|---|
| `services.status` | Zeigt den Zustand der Dienste (`docker compose ps --all`). | Assistent, Entwickler, Tester, Routine |
| `services.logs` | Zeigt die letzten Log-Zeilen (mit Zeitstempel). | Assistent, Entwickler, Tester, Routine |
| `services.restart` | Startet Dienste neu. | Assistent, Entwickler, Tester |
| `services.up` | Startet Dienste (`docker compose up -d`), optional mit Build. | Assistent, Entwickler, Tester |
| `services.stop` | Stoppt Dienste. | Assistent, Entwickler, Tester |

**Dienstnamen:** Angegeben wird der Name aus der Compose-Datei (zum Beispiel `api`, `web`, `db`). Ohne Dienstnamen gilt die Aktion für alle Dienste der Compose-Datei.

**Logs:** Zeilen von 1 bis 1000 (Standard 200). Der Zeitraum ist optional, im Format `15m` oder `2h` und höchstens 24 Stunden.

## 3. So fordert der Agent eine Aktion an

Der Agent schreibt die Anfrage als eigene Zeile in seine Antwort. Der Worker führt sie danach aus.

| Beispiel | Wirkung |
|---|---|
| `@@SERVICES: services.status` | Zustand aller Dienste |
| `@@SERVICES: services.logs api --lines=100 --since=15m` | 100 Zeilen des Dienstes `api`, nur aus den letzten 15 Minuten |
| `@@SERVICES: services.restart api` | Dienst `api` neu starten |
| `@@SERVICES: services.up --build` | Alle Dienste starten, Images vorher bauen |
| `@@SERVICES: services.up --file=deploy/compose.yml` | Eine andere Compose-Datei im Projekt verwenden |
| `@@SERVICES: services.stop db` | Dienst `db` stoppen |

Im Chat und im Assistenten siehst du die Anfrage als Ergebnis. Beispiel: `services.restart api: erledigt` oder `services.up: abgelehnt – …` mit dem Grund.

Das lokale Modell (Ollama) bekommt dafür ein eigenes Werkzeug mit denselben Feldern. Das Ergebnis ist dasselbe.

## 4. Bedingungen: wann eine Aktion ausgeführt wird

Der Worker prüft in dieser Reihenfolge. Scheitert eine Stufe, wird die Aktion abgelehnt, und der Grund steht im Ergebnis.

| Nr. | Prüfung | Ablehnung, wenn … |
|---|---|---|
| 1 | Rolle und Recht | die Rolle keine Dienst-Aktionen hat (Leserollen nie), die Gruppe „Projekt-Dienste“ für den Agent aus ist, oder die Rolle Routine ist und die Aktion startet, stoppt oder baut. |
| 2 | Projektordner | der Ordner nicht erreichbar ist. |
| 3 | Compose-Datei | im Projektordner keine Datei liegt (gesucht werden `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`) oder die angegebene Datei fehlt. |
| 4 | Lage der Datei | die Datei ausserhalb des Projektordners liegt. Auch ein Link, der nach aussen zeigt, wird abgelehnt. |
| 5 | Selbstschutz | der Projektordner der AIdeation-Installation selbst ist und die Aktion startet, neu startet, stoppt oder baut. Zustand (`status`) und Logs bleiben erlaubt. |
| 6 | Dienstnamen | ein Name in der Compose-Datei nicht vorkommt. Die Meldung nennt dann die vorhandenen Dienste. |
| 7 | Konfiguration (nur Start und Neustart) | die aufgelöste Compose-Konfiguration privilegierte Container, Mounts ausserhalb des Projektordners oder ähnliches enthält. |

Die Prüfungen 6 und 7 laufen unter der **Projektsperre**. Gleichzeitige Läufe am selben Projekt greifen also nicht ineinander. Die Sperre wird auch bei Fehlern wieder freigegeben.

**Grenzen je Anfrage:**

| Grenze | Wert |
|---|---|
| Dienstnamen je Aktion | höchstens 10 |
| Aktionen je Antwort | höchstens 5 (weitere werden nicht ausgeführt und als solche gemeldet) |
| Zeilen bei `services.logs` | 1 bis 1000, Standard 200 |
| Zeitraum bei `services.logs` | höchstens 24 Stunden |
| Ausgabe im Ergebnis | maskiert und auf 8000 Zeichen gekürzt |
| Laufzeit einer Aktion | höchstens 10 Minuten |

Ungültige Angaben werden sofort abgelehnt, bevor der Worker etwas startet. Beispiele: ein Dienstname mit Leerzeichen, `--lines=5000`, `--since=3d`, `--build` bei `services.restart`.

## 5. Rechte: die Gruppe „Projekt-Dienste“

Die frühere Gruppe „Docker-Dienste“ entfällt. Ihre Stelle übernimmt die Gruppe **„Projekt-Dienste“** (intern `services`). Sie ist betriebssystem-neutral und enthält keine Shell-Regel mehr. Sie schaltet nur die Aktionen frei.

- **Ist sie aus**, lehnt der Worker jede Dienst-Aktion ab, mit dem Hinweis, dass die Gruppe nicht freigegeben ist.
- **Ist sie an**, gelten die Rollen aus Abschnitt 2 und die Prüfungen aus Abschnitt 4.

**Was sich für bestehende Projekte ändert:** Gespeicherte alte Regeln werden beim Laden automatisch umgestellt. Dazu zählen:

- `launchctl kickstart …` und `launchctl list` (für jede Benutzer-ID und jeden Dienstnamen),
- `docker compose …`, `docker ps` und `docker logs`,
- die Gruppe „docker“ (sie wird zu „services“).

Die Umstellung läuft bei jedem Laden. Ein zweiter Durchlauf ändert nichts. Du musst also nichts von Hand umstellen.

**Was die Gruppe nicht abdeckt:** Die Gruppe „Dienst-Logs“ liest noch Logs unter `~/Library/Logs` und ist macOS-spezifisch. Sie ist nicht Teil dieser Phase und wird in Phase 3 bearbeitet.

## 6. Einschränkungen

| Bedingung | Was passiert |
|---|---|
| Dienst-Aktion im **Chat** oder **Assistenten** | Der Marker wird ausgewertet, das Ergebnis erscheint in der Antwort. |
| Dienst-Aktion in einem **Workflow-Lauf** | Der Marker wird **nicht** ausgewertet. Die Zeile bleibt als Text stehen, und es wird nichts ausgeführt. Das ist für Phase 3 vorgesehen. |
| Projekt ohne Compose-Datei | Jede Aktion scheitert mit dem Hinweis, dass keine Compose-Datei vorhanden ist. Er ist nicht stumm. |
| Projekt mit launchd-Dienst, aber ohne Compose-Datei | Der Projekt-Assistent zeigt einen Hinweis (Abschnitt 7). Die Dienste laufen weiter, bis du sie umgestellt hast. Der Agent kann sie über `services.restart` nicht neu starten. |
| Docker nicht erreichbar | Die Aktion scheitert mit dem Docker-Fehler im Ergebnis. |

## 7. Der Hinweis für launchd-Dienste (Projekt-Assistent)

Agents starten Dienste nur noch über Docker Compose. Projekte, die noch launchd-Dienste nutzen, bekommen deshalb im **Projekt-Assistenten** einen Hinweis.

- **Erscheinen:** Auf macOS sucht AIdeation in `~/Library/LaunchAgents` nach Startdateien (`.plist`), die den Projektordner nennen. Findet es welche, erscheint ein Warnhinweis mit den Namen der Dienste (Kennung `launchd-hint`).
- **Zusatz im Hinweis:** Liegt im Ordner schon eine Compose-Datei, steht dort, dass du die Dienste darauf umstellen und die launchd-Dienste entfernen sollst. Liegt keine vor, wird dir geraten, eine `compose.yaml` anzulegen.
- **Andere Systeme:** Dort gibt es keine launchd-Dienste, also erscheint kein Hinweis.

Der Hinweis ist nur eine Warnung. Er ändert nichts an den Diensten.

## 8. Fehlerbehebung

- **„Dienst-Aktionen sind für diesen Agent nicht freigegeben.“** Die Gruppe „Projekt-Dienste“ ist für das Projekt aus. Sie in den Rechten des Projekts einschalten.
- **„Im Projektordner liegt keine Compose-Datei.“** Lege eine `compose.yaml` im Projektordner an oder gib mit `--file=` den richtigen Pfad im Projekt an.
- **„… liegt ausserhalb des Projektordners.“** Die Datei oder ein Link zeigt nach aussen. Verschiebe die Datei in den Projektordner.
- **„AIdeation selbst startet, stoppt und baut kein Agent neu.“** Der Projektordner ist der Ordner der AIdeation-Installation. Das bleibt absichtlich gesperrt. AIdeation startest du von Hand neu.
- **„… ist kein gültiger Dienstname.“ oder „unbekannte Dienste …“** Der Name stimmt nicht mit der Compose-Datei überein. Die Meldung nennt die vorhandenen Namen.
- **„… (privilegiert / Mount ausserhalb)“.** Die Konfiguration des Dienstes ist für einen Start nicht erlaubt. Passe die Compose-Datei an (nur Mounts und Builds im Projektordner, keine privilegierten Container).
- **„Die Rolle „…“ darf Dienste nur ansehen.“** Die Routine darf nur Status und Logs lesen. Für einen Neustart braucht es einen Assistenten, Entwickler oder Tester.
- **Der Agent schreibt `docker compose …` oder `launchctl …` in den Befehl.** Das wird gesperrt, weil diese Befehle in keiner Rechte-Gruppe mehr stehen. Der Agent muss die Dienst-Aktion nutzen.

## 9. Noch offen

- Die Dienst-Aktionen in **Workflow-Läufen** (`runner-agent.ts`) sind noch nicht eingebaut. Das ist Phase 3.
- Die Gruppe **„Dienst-Logs“** liest noch `~/Library/Logs`. Sie wird in Phase 3 plattformneutral gemacht oder ersetzt.
- **Praxistest mit echtem Docker:** `services.status` und `services.restart` an einem Projekt mit Compose-Datei. Ebenso der Hinweis für ein Projekt mit launchd-Dienst.
- **Tests:** Die Tests (`npm test`, `npm run typecheck`, `npm run test:e2e`) sind vom Entwickler gemeldet, aber in diesem Kapitel nicht selbst gelaufen.

## 10. Printscreens, die noch fehlen

Für ein vollständiges Handbuch sollten diese Aufnahmen entstehen (mit laufender App und Docker):

1. **Chat oder Assistent:** Antwort mit dem Abschnitt „Dienst-Aktionen“ nach einem `services.restart`.
2. **Chat oder Assistent:** Abgelehnte Aktion, zum Beispiel `services.up` mit einer Compose-Datei ausserhalb des Projekts.
3. **Rechte des Projekts:** Gruppe „Projekt-Dienste“ an und aus.
4. **Projekt-Assistent:** Hinweis für launchd-Dienste (Kennung `launchd-hint`), mit und ohne vorhandene Compose-Datei.
5. **Marketing-Seite „Agent-Rechte“:** Gruppe „Projekt-Dienste“ mit der neuen Beschreibung.

---

*Quelle: Auftrag 2cb9201f, Branch `auftrag/2cb9201f-docker-sandbox-phase-2-dienste-u`, Commit 92cf563 (Entwickler) und `docs/docker-sandbox-phase-2-dienste-ueber-worker-aktionen-2026-10-29.md`. Nicht committet.*
