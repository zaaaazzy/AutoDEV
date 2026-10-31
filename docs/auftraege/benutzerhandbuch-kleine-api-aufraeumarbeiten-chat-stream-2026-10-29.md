# Benutzerhandbuch: Chat mit mehreren Tabs und verzögerte Nachrichten

Auftrag f9aae445 (Sprint 28). Dieses Kapitel beschreibt, was du am Assistenten-Chat merkst, wenn du mehrere Tabs offen hast. Die Entwicklerdoku steht in [`kleine-api-aufraeumarbeiten-sprint-index-sql-chat-stream-2026-10-29.md`](kleine-api-aufraeumarbeiten-sprint-index-sql-chat-stream-2026-10-29.md).

> **Was sich geändert hat:** Der Chat aktualisiert sich jetzt im Hintergrund seltener, und die Zahl gleichzeitig offener Live-Verbindungen ist begrenzt. Jetzt gilt:
>
> - Neue Nachrichten erscheinen bis zu **3 Sekunden** später als vorher (vorher etwa 1 Sekunde).
> - Pro Sitzung sind höchstens **3 Chat-Verbindungen** gleichzeitig offen. Ein vierter Tab mit demselben Login bekommt keine Live-Verbindung.
> - Der vierte Tab zeigt den Hinweis „Verbindung zum Assistenten unterbrochen“ und lädt den Verlauf weiter alle 3 Sekunden nach. Du verlierst also keine Nachrichten, aber sie kommen nur auf diesem Weg.
>
> **Printscreens:** keine. In dieser Sitzung lief weder die App mit Datenbank noch ein Browser. Die Bedingungen stammen aus dem Code (`src/api/chat-routes.ts`, `frontend/src/app/features/chat/chat.component.ts` und `chat.component.html`). Die Tests wurden für dieses Handbuch nicht ausgeführt.

---

## 1. Was du siehst

| Situation | Was du siehst |
| --- | --- |
| Ein bis drei Chat-Tabs derselben Sitzung offen | Wie bisher. Nachrichten erscheinen in allen Tabs, meist innerhalb von 3 Sekunden. |
| Vierter Chat-Tab derselben Sitzung | Oben im Chat steht „Verbindung zum Assistenten unterbrochen – wird automatisch neu aufgebaut.“ Der Verlauf wird alle 3 Sekunden nachgeladen. |
| Ein Tab wird geschlossen | Der Platz wird sofort frei. Der vierte Tab verbindet sich beim nächsten automatischen Versuch, spätestens nach 30 Sekunden, oder sofort über **Jetzt neu verbinden**. |
| Der Hinweis bleibt im vierten Tab stehen | Das ist gewollt, solange drei andere Tabs offen sind. Schließe einen davon und klicke im vierten Tab auf **Jetzt neu verbinden**. |

Die Fehlermeldung des Servers („Zu viele offene Chat-Verbindungen – bitte andere Tabs schliessen.“) siehst du nicht. Der Browser zeigt sie nicht an. Der Hinweis oben im Chat ist das Einzige, was sichtbar wird.

---

## 2. Bedingungen

- **Zählt wird pro Sitzung.** Eine Sitzung ist ein Login. Zwei Browser mit demselben Benutzer haben je eine eigene Sitzung und je eigene 3 Plätze.
- **Ohne Login** zählt die IP-Adresse. Hinter einem Proxy, der die echte Adresse nicht weitergibt, teilen sich dann alle Benutzer die 3 Plätze.
- **Die Zählung liegt im Speicher des API-Prozesses.** Nach einem Neustart der API sind alle Plätze wieder frei. Laufen mehrere API-Prozesse, gilt das Limit je Prozess.
- **Nachrichten kommen mit Verzögerung.** Eine Änderung erscheint frühestens nach dem nächsten Abfrageintervall von 3 Sekunden.

---

## 3. Beispiele

**Du hast vier Chat-Tabs offen.** Die ersten drei zeigen Nachrichten live. Im vierten steht der Hinweis „Verbindung unterbrochen“. Schreibst du in Tab eins, erscheint die Antwort im vierten Tab innerhalb von etwa 3 Sekunden, weil er den Verlauf nachlädt. Schließe Tab drei und klicke im vierten auf **Jetzt neu verbinden**. Dann ist die Live-Verbindung wieder da und der Hinweis verschwindet.

**Du arbeitest an einem Laptop und einem Handy.** Beide Geräte haben eigene Sitzungen. Jedes hat seine 3 Plätze.

---

## 4. Fehlerbehebung

- **Der Hinweis „Verbindung unterbrochen“ bleibt stehen.** Prüfe, ob du mehr als drei Chat-Tabs derselben Sitzung offen hast. Schließe einen davon und klicke auf **Jetzt neu verbinden**. Hilft das nicht, Seite neu laden.
- **Eine Antwort kommt erst nach ein paar Sekunden.** Das ist das Abfrageintervall von 3 Sekunden, kein Fehler.
- **Der Hinweis erscheint, obwohl nur wenige Tabs offen sind.** Zähle auch Fenster und Tabs in anderen Browsern mit, die mit derselben Sitzung laufen. Schließe überzählige Tabs oder melde dich ab und wieder an.

---

## 5. Für Entwickler

- Abfrageintervall: `STREAM_POLL_MS = 3000` in `src/api/chat-routes.ts`. Die Obergrenze je Sitzung ist `MAX_STREAMS_PER_SESSION = 3`.
- Das Frontend ist unverändert. Es fällt bei dem 429 auf sein Ersatz-Polling zurück (`FALLBACK_POLL_MS = 3000` in `chat.component.ts`) und versucht die Verbindung mit wachsendem Abstand bis 30 Sekunden neu.
- Jeder neue Ausstieg aus dem Stream muss `stop()` nutzen, sonst bleibt ein Platz belegt.

## Offen

- Printscreens fehlen. Nachzuholen, wenn die App mit Datenbank lokal läuft: ein Chat mit drei offenen Tabs und einer mit dem Hinweis „Verbindung unterbrochen“.
- Die Tests für diesen Auftrag wurden für dieses Handbuch nicht ausgeführt. Der Stand auf `main` zu `npm run test:unit` ist offen, siehe die Entwicklerdoku.
