# Push-Abos: SSRF verhindern, Besitz prüfen, beim Logout abmelden

Auftrag 7ec815c1 (Bugfix, Schwere hoch, 25.10.2026). Sprint 23. Der Zweig enthält auch den Inhalt von `auftrag/f230ad31-push-abos-ssrf-verhindern-besitz`; dieser Zweig wird nicht zusätzlich gemergt.

## Ursache

- `POST /push/subscribe` nahm jede `https://`-Adresse an. `deliverPush` schickte dann POST-Anfragen an beliebige Ziele (SSRF, z. B. ins LAN).
- Das Anmelden überschrieb per `ON CONFLICT` den Besitzer eines Abos. Ein fremdes Gerät ließ sich so übernehmen.
- `POST /push/unsubscribe` löschte jeden Endpunkt ohne Besitzprüfung.
- Beim Abmelden blieb das Push-Abo des Geräts bestehen.

## Umsetzung

- **Allowlist** (`src/core/push.ts`, `isAllowedPushEndpoint`): nur https ohne Port und Zugangsdaten, Länge höchstens 1000. Erlaubt sind `fcm.googleapis.com`, `updates.push.services.mozilla.com` sowie Unterdomänen von `push.apple.com` und `notify.windows.com`. Es ist bewusst eine Positivliste, weil DNS-Rebinding eine IP-Sperrliste umgeht.
- **Senden** (`deliverPush`): Endpunkte außerhalb der Liste (Altdaten, Zwischenspeicher des Wächters) werden nie angefragt und als `gone` gemeldet. Der Sender ist als Parameter `send` austauschbar (für Tests).
- **Anmelden** (`src/api/push.ts`): ungültiger Endpunkt gibt 400. Bei einem Konflikt werden Schlüssel nur aktualisiert, wenn `user_id` und `system_admin` übereinstimmen. Ein Abo eines anderen Besitzers bleibt unverändert, die Antwort ist gleich.
- **Abmelden und Löschen** (`deleteOwnSubscription`): löscht nur das eigene Abo (ohne Konto: `system_admin`). Ohne Principal wird die Datenbank nicht angefragt. `/push/unsubscribe` nutzt diese Funktion.
- **Logout** (`src/api/auth.ts`): `/logout` liest den Besitzer aus der Sitzung und löscht das Abo mit dem mitgeschickten Endpunkt, danach die Sitzung. Ohne gültige Sitzung wird nichts gelöscht, auch kein Abo des Systemadministrators.
- **Wächter** (`src/runner/watchdog.ts`): `gone`-Endpunkte werden auch aus dem Zwischenspeicher (`state.subscriptions`) entfernt. Die Datenbank wird nur bei `dbOk` angefragt.
- **Oberfläche** (`push-logout.ts`, `security-settings.component.ts`): `logoutWithPush` meldet Abo am Server und im Browser ab, dann `/api/logout`. Fehler blockieren den Logout nie; der Endpunkt geht zusätzlich im Logout mit.
- **Doku:** Absatz in `docs/installation.md`.

## Geänderte Dateien

- `src/core/push.ts`, `src/core/push.test.ts`
- `src/api/push.ts`, `src/api/push.test.ts`
- `src/api/auth.ts`
- `src/runner/watchdog.ts`, `src/runner/watchdog.test.ts`
- `frontend/src/app/features/settings/push-logout.ts`, `push-logout.spec.ts`, `security-settings.component.ts`
- `docs/installation.md`

## Worauf zu achten ist

- **Roter Test:** Der Bug-Wächter vermutet, dass ein Testwert (`ENDPOINT = 'https://push.example.test/…'` in `src/api/push.test.ts`) die Allowlist nicht passiert. Der Testwert muss auf einen erlaubten Dienst geändert werden, nicht die Prüfung. Die Stacktrace-Zeile 164 passt nicht zur Dateilänge; zuerst klären, welcher Test wirklich rot ist.
- **Test „erneute Anmeldung übernimmt das Gerät“:** Er widerspricht der Besitzprüfung. Ein fremdes Gerät darf nicht still übernommen werden; der Test ist entsprechend anzupassen, falls er noch Übernahme erwartet.
- **Gezielt testen:** `npx --no-install tsx --test src/api/push.test.ts src/core/push.test.ts src/runner/watchdog.test.ts` und die Spec `push-logout.spec.ts`, ohne Abdeckungs-Flags (der Wächter blockiert sie). Tests mit echter Datenbank brauchen die Postgres-Testdatenbank. Belegt grün ist bisher nur der Typecheck; Entwickler und Dokumentierer haben die Tests nicht ausgeführt. Der letzte Testlauf des Testers hatte 18 von 19 Tests grün, einen roten.
- **Bestehende Abos:** Geräte mit Endpunkten anderer Dienste werden beim nächsten Senden verworfen. Das ist gewollt.
- **Pflege:** Neue Push-Dienste von Browsern müssen in `PUSH_HOSTS` bzw. `PUSH_DOMAINS` ergänzt werden.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| 7ec815c1 Push-Abos: SSRF, Besitz, Logout | umgesetzt, ein Push-Test noch rot | Allowlist, Besitzprüfung, Logout löscht Abo, Wächter-Cache bereinigt |

## Stand 29.10.2026 (nach Nachziehen von `sprint/sprint-28`)

- Die Merge-Konflikte sind gelöst. In `src/api/push.test.ts` und `src/core/push.test.ts` gelten jetzt beide Stände: die Tests mit Speicher-Pool aus diesem Auftrag und der PostgreSQL-Test aus Sprint 28. Dieser verwendet als Testwert `https://fcm.googleapis.com/…` und prüft, dass ein fremdes Gerät nicht übernommen wird. Der rote Test aus Sprint 23 ist damit erledigt.
- `src/core/push.ts`: Es gilt die Formatierung aus Sprint 28. Inhaltlich ist nichts anders: Die Allowlist wird auch beim Senden geprüft.
- `npm run typecheck` ist grün. In `npm run test:unit` sind alle Push- und Logout-Tests grün (11 im Backend und 3 in `push-logout.spec.ts`), auch der Test gegen PostgreSQL.
- Zwei Tests sind noch rot, beide in `styles-order.spec.ts`. Sie hängen nicht mit diesem Auftrag zusammen. Im Arbeitsordner liegt die verwaiste Datei `frontend/src/styles/27-settings.css`. `angular.json` lädt sie nicht, und ihr Inhalt steht bereits in `17-settings.css` und `04-components.css`. Die Datei muss mit `git rm` entfernt werden. Der Entwickler durfte in diesem Schritt keine git-Befehle ausführen.

## Anfrage / TODO

- `frontend/src/styles/27-settings.css` entfernen (siehe oben), danach `styles-order.spec.ts` erneut ausführen.
