# Benutzerhandbuch: Überschreitungs-Stopp und Trefferquote der Schätzung

Gilt ab Auftrag 099e001e-45ef-4005-ad93-980165a79487. Betrifft die Schätzung von Aufträgen, die Idee-Detailansicht (Art), die Statistik (Trefferquote und Korrekturfaktor) und die Freigabe unter „Aktion notwendig“.

## Was sich ändert

Bisher wurde die Schätzung eines Auftrags nur angezeigt. Lief ein Auftrag länger oder verbrauchte mehr Tokens als geschätzt, lief er bis zum Sprintbudget weiter. Die Schätzung wich in der Praxis um das 14- bis 34-Fache ab, in beide Richtungen.

Jetzt gilt:

- **Der Auftragsautor vergleicht genauer.** Er stützt sich auf den Median des echten Verbrauchs ähnlicher erledigter Aufträge. Ähnlich heißt: gleiche Kategorie, gleiche Art (Feature oder Bug) und gleiche Anzahl betroffener Bereiche.
- **Ideen haben eine Art.** Damit werden sie nur mit Aufträgen gleicher Art verglichen.
- **Ein laufender Auftrag wird gestoppt, wenn er das Dreifache seiner Schätzung überschreitet.** Er wartet dann als „Aktion notwendig“, statt bis zum Sprintbudget weiterzulaufen.
- **Die Statistik zeigt die Trefferquote der Schätzung je Sprint** sowie den Korrekturfaktor und die Anzahl der Messwerte je Herkunft.

Keine Änderung gibt es bei Nutzen und Kosten, beim Budget (Tages- und Sprintbudget) und bei der Abnahme. Es gibt keine neue Seite.

## Bedingungen

### 1. Art der Idee

- Jede Idee hat eine Art: `feature` oder `bug`.
- Die Art lässt sich in der Idee-Detailansicht unter „Art“ einstellen.
- Ohne Angabe gilt `feature`. Bestehende Ideen erhalten diesen Standard automatisch.
- Eine Idee wird nur mit Aufträgen ihrer Art verglichen. Eine Idee ohne Art also nur mit `feature`-Aufträgen, eine Idee mit Art `bug` nur mit `bug`-Aufträgen.

### 2. Ist-Referenz des Auftragsautors

Der Auftragsautor sucht ähnliche erledigte Aufträge in dieser Reihenfolge:

| Stufe | Vergleich | Wann sie gilt |
|---|---|---|
| 1 | Kategorie, Art und Anzahl betroffener Bereiche | Mindestens 5 Aufträge in dieser Gruppe |
| 2 | Kategorie und Art, ohne Bereichsfilter | Die engste Gruppe hat weniger als 5 Aufträge |

- **Anzahl betroffener Bereiche:** 1 Bereich, 2 bis 3 Bereiche, 4 und mehr. Gezählt werden die Dateien, die die Beschreibung im Abschnitt „Technische Hinweise“ bzw. „betroffene Dateien“ nennt (oder in Backticks als Pfad setzt).
- **Keine erkennbaren Dateien:** Nennt die Beschreibung keine Datei, gibt es keine Bereichsgruppe. Dann gilt Stufe 2.
- Der Prompt nennt, welche Gruppe verwendet wurde: „Median genau dieser Gruppe“ bei Stufe 1, „Median der Kategorie“ bei Stufe 2. Außerdem stehen Art und Bereichsgruppe darin.

### 3. Korrekturfaktor je Herkunft

- Der Faktor ist der Median von Ist ÷ Schätzung der letzten 20 erledigten Aufträge je Projekt. Er wird je Herkunft der Schätzung gebildet.
- Unter 5 Messwerten gilt der Faktor **1**. Dann wird die Schätzung nicht korrigiert.
- Die Statistik zeigt den Faktor und die Anzahl der Messwerte je Herkunft (Abschnitt „Korrekturfaktor je Herkunft“). Bei weniger als 5 Messwerten gilt der Faktor 1.

### 4. Überschreitungs-Stopp

Die kalibrierte Schätzung ergibt sich aus der gespeicherten Schätzung mal Korrekturfaktor. Die Prüfung läuft so:

1. Ein Agent-Schritt ist beendet.
2. Die Budget-Prüfung läuft wie bisher.
3. Der gemessene Verbrauch wird ermittelt: Laufzeit in Stunden und Tokens aller Agent-Schritte, bei allen Rollen (auch beim Tester), seit dem letzten Start oder der letzten Freigabe.
4. Der Verbrauch wird mit dem **Dreifachen** der kalibrierten Schätzung verglichen.
   - Stunden **oder** Tokens liegen **über** dem Dreifachen: Der Auftrag wird gestoppt.
   - Genau das Dreifache läuft weiter. Die Grenze ist streng ausgelegt („über“).
5. Gestoppt: Der nächste Schritt startet nicht. Der Auftrag erhält den Status **blockiert** und den Hinweis in „Aktion notwendig“.

Der Hinweis lautet sinngemäß: „Schätzung überschritten: Ist 1,6 h / 9,2 Mio. Tokens, Schätzung 0,5 h / 2,0 Mio. Tokens – prüfen, dann „Erneut versuchen““. Der Auftrag selbst (Feld `failure`) nennt Ist- und Schätzwert ebenso.

Wichtig:

- **Gemessen wird nach abgeschlossenen Schritten.** Ein einzelner langer Schritt kann die Grenze deutlich überschreiten, bevor der Stopp greift.
- **Aufträge ohne Schätzung** (weder Stunden noch Tokens) werden nicht geprüft.
- **Ist eine Schätzung nur für einen der beiden Werte gesetzt,** wird nur dieser geprüft.
- **Ein von Hand gestarteter Einzel-Agent** gilt selbst als Freigabe und wird nicht geprüft.
- **Ist die Prüfung selbst nicht möglich** (zum Beispiel die Datenbank ist kurz nicht erreichbar), startet der Agent nicht. Der Auftrag gilt als unterbrochen und startet nach einer Pause von 5 Minuten wieder. Er läuft nicht unkontrolliert weiter.

### 5. Freigabe durch einen Menschen

- Die Freigabe erfolgt über **„Erneut versuchen“** auf dem Auftrag unter „Aktion notwendig“. Dazu braucht es die Berechtigung zum Ausführen von Aufträgen.
- Die Sperre wird aufgehoben. Der Verbrauch wird **ab diesem Zeitpunkt neu gezählt**. Die Schwelle gilt dann für die aktuelle Schätzung.
- Der Auftrag startet **nicht automatisch**. Er kommt in den Status „Geplant“ und läuft mit dem nächsten Sprintlauf weiter.
- Wer die Schätzung nicht erhöht, blockiert nach dem Dreifachen des neuen Verbrauchs erneut.
- Die Freigabe zählt nicht als Fehlversuch. Der Wiederholungszähler steigt nicht.

### 6. Trefferquote je Sprint

- **Treffer:** Ein erledigter Auftrag mit Schätzung und gemessenem Verbrauch ist ein Treffer, wenn **Stunden und Tokens** jeweils zwischen dem **0,5-Fachen und dem 2,0-Fachen** der kalibrierten Schätzung liegen. Die Grenzen zählen mit.
  - Beispiel: Stunden bei 0,4-facher Schätzung sind kein Treffer.
- **Anzeige:** Prozentwert und „x von y“. Dabei ist x die Zahl der Treffer, y die Zahl der gemessenen erledigten Aufträge des Sprints.
  - Beispiel: 6 Treffer bei 8 gemessenen Aufträgen zeigt „75 % (6 von 8)“.
- **Ohne gemessene Aufträge** zeigt die Spalte „–“ und nicht 0 %.
- Die Trefferquote misst vor allem, wie stabil der Faktor ist. Die Schätzung wird aus denselben Daten gelernt. Bei wenigen Messwerten ist die Quote unsicher. Deshalb steht die Anzahl dabei.

### 7. Budget bleibt unverändert

Die Budget-Prüfung (Tages-, Sprint-, Auftrags- und Rollenbudget) bleibt wie bisher. Sie läuft zusätzlich zum Überschreitungs-Stopp und zuerst. Ein erreichtes Budget blockiert den Auftrag weiterhin mit „Budget erreicht“.

## Was du siehst

| Situation | Was passiert |
|---|---|
| Ein laufender Auftrag überschreitet das Dreifache bei Stunden oder Tokens | Er wird **blockiert**. Er erscheint unter „Aktion notwendig“ mit „Schätzung überschritten“ und Ist- und Schätzwert. Der nächste Schritt startet nicht. |
| Auftrag bei genau dem Dreifachen | Er läuft weiter. |
| Auftrag ohne Schätzung | Er wird nie durch diese Prüfung blockiert. |
| Nach „Erneut versuchen“ | Der Auftrag geht auf „Geplant“. Der Verbrauch zählt neu. Er startet mit dem nächsten Sprintlauf. |
| Die Prüfung selbst scheitert | Der Auftrag wird unterbrochen und nach 5 Minuten wieder eingeplant. Der Grund steht im Feld `failure`. |
| Statistik, Sprint mit gemessenen Aufträgen | Spalte „Trefferquote“ mit Prozentwert und „x von y“. |
| Statistik, Sprint ohne gemessene Aufträge | „–“ |
| Statistik, Abschnitt „Korrekturfaktor je Herkunft“ | Faktor und Anzahl der Messwerte je Herkunft. Unter 5 Messwerten steht der Faktor 1. |
| Idee-Detailansicht | Auswahl „Art“ mit `feature` (Standard) oder `bug`. |

## Beispiel

Ein Feature-Auftrag hat eine gespeicherte Schätzung von 2 Stunden und 1 Mio. Tokens. Der Korrekturfaktor für diese Herkunft ist 1,2.

- Kalibrierte Schätzung: 2,4 Stunden und 1,2 Mio. Tokens.
- Grenze (das Dreifache): 7,2 Stunden und 3,6 Mio. Tokens.
- Nach dem zweiten Agent-Schritt zeigt der Verbrauch 7,5 Stunden und 2,0 Mio. Tokens. Die Stunden liegen über 7,2. Der Auftrag wird blockiert, bevor der dritte Schritt startet. Unter „Aktion notwendig“ steht der Hinweis mit Ist- und Schätzwert.
- Du prüfst, ob die Schätzung stimmt. Ist sie zu niedrig, passt du sie an und gibst den Auftrag mit „Erneut versuchen“ frei. Die Messung beginnt dann neu, und der Auftrag läuft mit dem nächsten Sprintlauf weiter.

## Printscreens

**Keine.** Ich konnte in dieser Umgebung keine Aufnahmen machen. Es fehlen ein Browser (Chromium), eine laufende Datenbank (Postgres oder Docker) und die `DATABASE_URL`. Ohne sie lässt sich die App nicht starten und nichts anzeigen.

Diese Bilder sollten beim nächsten Durchgang mit der App entstehen:

1. Die Statistik mit der Spalte „Trefferquote“ je Sprint, einmal mit einem gemessenen Sprint und einmal mit „–“.
2. Der Abschnitt „Korrekturfaktor je Herkunft“ in der Statistik.
3. Die Idee-Detailansicht mit der Auswahl „Art“.
4. Ein blockierter Auftrag unter „Aktion notwendig“ mit dem Hinweis „Schätzung überschritten“ und der Schaltfläche „Erneut versuchen“.

Dafür braucht es eine laufende App mit Datenbank, zum Beispiel `npm run seed:demo` und einen Browserlauf mit Playwright. Dabei ist zu beachten, dass die Schaltfläche „Erneut versuchen“ nur für Nutzer mit der Berechtigung zum Ausführen erscheint.

## Offen

- Die Tests (`npm run typecheck`, `npm run test:unit`, `npm run format:check`) sind nicht gelaufen. Die Angaben stammen aus der Dokumentation des Entwicklers und aus dem Code, den ich gelesen habe. Der Tester hat den Lauf mit `tsc` und dem npm-Cache nicht abgeschlossen.
- Die Printscreens fehlen (siehe oben).
- Die Oberfläche wurde nicht im Browser geprüft. Die Beschreibung der Schaltflächen und Texte stammt aus dem Code.
- Ob „Erneut versuchen“ in der „Aktion notwendig“-Karte für jede Rolle sichtbar ist, habe ich nicht im Frontend nachgeprüft. Die API prüft die Berechtigung in jedem Fall.
- Die Vorgänger-Dokumentation nennt die Bereichszählung über `affectedFiles`. Im Code wird sie aus der Beschreibung abgeleitet (`areaBucket` in `src/core/sprint-planner.ts`). Das Handbuch folgt dem Code.
- `docs/laufzeit.md` und `docs/workflows.md` wurden von der Dokumentation des Entwicklers geändert. Ich habe sie nicht gegen die Änderungen gelesen.
