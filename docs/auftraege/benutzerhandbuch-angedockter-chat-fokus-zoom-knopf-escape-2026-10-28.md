# Benutzerhandbuch: Assistent-Chat – Fokus, Zoom-Knopf und Escape

Auftrag 9e136e05 (Bugfix, Sprint 23). Dieses Kapitel beschreibt, wo der Cursor beim Öffnen des Assistenten steht, wann der Zoom-Knopf erscheint und was Escape im Chat tut.

> **Was sich geändert hat:** Vorher landete der Cursor nach dem Öffnen des Chats nirgends (er fiel auf die Seite selbst), und der Zoom-Knopf blieb im angedockten Chat sichtbar. Ein Klick darauf öffnete ein zweites, kleines Fenster. Jedes Escape auf der Seite dockte den Chat ab, auch wenn du einen anderen Dialog schliessen wolltest. Jetzt gilt das unten Beschriebene.
>
> **Printscreens:** keine. Die App lief für diesen Auftrag nicht, und ein Browser-Lauf ist nicht erfolgt. Die Bedingungen unten stammen aus dem Code (`frontend/src/app/features/chat/chat.component.ts` und `.html`, `chat-bubble.component.ts`, `chat-focus.ts`, `shared/modal.component.ts`).

---

## 1. Die drei Ansichten des Chats

Der Assistent-Chat kommt in drei Formen vor:

| Form | Wo | Wie du sie bekommst |
| --- | --- | --- |
| **Sprechblase** | unten rechts auf jeder Seite | Klick auf die Sprechblase öffnet ein kleines Fenster |
| **Angedockt** | rechts neben dem Hauptbereich | Auf der Sprechblase automatisch beim Öffnen, wenn das Fenster mindestens **1200 px** breit ist; sonst über den Zoom-Knopf |
| **Modal** | Dialog über der Seite, mit abgedunkeltem Hintergrund | Zoom-Knopf in der Sprechblase (immer Modal); im Dashboard-Chat bei einem Fenster unter 1200 px |

Die Sprechblase öffnet nie angedockt, ausser das Fenster ist breit genug. Ihr Zoom-Knopf öffnet immer das Modal, nie das Andocken.

---

## 2. Was beim Öffnen mit dem Cursor passiert

- **Sprechblase öffnen:** Der Cursor steht sofort im Eingabefeld. Du kannst gleich tippen.
- **Sprechblase automatisch angedockt (breites Fenster):** Auch hier steht der Cursor im Eingabefeld. Die Sprechblase selbst ist in dieser Ansicht ausgeblendet, der Cursor landet trotzdem im Feld.
- **Zoom-Knopf (Modal öffnen):** Der Cursor steht im Eingabefeld des Modals. Die Stelle, an der du vorher warst, merkt sich der Chat.
- **Modal schliessen:** Der Cursor kehrt an die Stelle zurück, an der du vorher warst. Ist diese Stelle nicht mehr da, steht er im Eingabefeld.
- **Sprechblase schliessen (✕ im Chat):** Der Cursor springt auf die Sprechblase unten rechts, damit du mit der Tastatur weitermachen kannst.

---

## 3. Der Zoom-Knopf

Der Knopf sitzt in der Kopfzeile des Chats, neben „Verlauf leeren“. Sein Symbol und sein Tooltip wechseln je nach Zustand:

| Zustand | Knopf zeigt | Was ein Klick tut |
| --- | --- | --- |
| normal | „Chat vergrößern“ | Öffnet das Modal (bei der Sprechblase) bzw. angedockt oder Modal (je nach Fensterbreite) |
| vergrössert (Modal oder angedockt) | „Verkleinern“ | Zurück zur normalen Ansicht |

**Wann der Knopf fehlt:** Ist die **Sprechblase angedockt** (breites Fenster), fehlt der Zoom-Knopf ganz. Es gibt dann nur ✕ zum Schliessen. Das verhindert das zweite, kleine Fenster neben dem angedockten Chat.

**Wann du ihn wieder siehst:** Nur solange die Sprechblase angedockt ist, fehlt er. Verkleinerst du das Fenster unter 1200 px, erscheint er in der kleinen Sprechblase wieder. Der Dashboard-Chat hat keinen solchen Sonderfall; sein Zoom-Knopf ist immer da.

**Fensterbreite beim Andocken:** Wird ein angedockter Chat unter 1200 px schmal, wechselt er automatisch ins Modal. Das Modal bleibt dann offen, bis du es schliesst.

---

## 4. Escape

Escape gehört dem Chat **nur** in diesen Fällen:

1. Der Chat ist vergrössert (angedockt oder Modal), **und**
2. der Fokus steht **im Chat** – oder der Chat ist ein Modal und der Fokus steht auf der Seite selbst (nirgends, also auf `body`).

Dann verkleinert Escape den Chat. Im angedockten Zustand bleibt die Sprechblase als kleines Fenster offen; im Modal schliesst sich das Modal und der Cursor kehrt zurück.

**Escape tut nichts mit dem Chat, wenn:**

- ein **anderer Dialog** offen ist (z. B. eine Bestätigung oder eine Hilfe). Dann schliesst Escape diesen Dialog, und der Chat bleibt unverändert, auch wenn er angedockt ist.
- ein **Aufgaben-Menü** im Chat offen ist. Escape schliesst zuerst das Menü.
- der Chat **nicht vergrössert** ist. Dann gibt es keinen Escape-Effekt im Chat.
- der Fokus auf einem anderen Teil der Seite liegt (z. B. in einem Eingabefeld des Projekts) und der Chat angedockt ist.

**Kurz:** Ein Escape schliesst immer zuerst das, worin du gerade bist. Der Chat verkleinert sich nur, wenn du im Chat bist oder das Modal offen ist.

---

## 5. Tastatur im Modal

Ist der Chat als Modal offen, bleibt die Tab-Taste im Dialog:

- **Tab** am Ende der Liste springt zum Anfang (Eingabefeld, Knöpfe, Auswahl).
- **Shift+Tab** am Anfang springt zum Ende.
- Der Fokus verlässt das Modal nicht, solange es offen ist. Mit der Maus kannst du den Hintergrund trotzdem anklicken: Das schliesst das Modal.

Im angedockten Chat und in der Sprechblase gilt diese Fokusfalle nicht. Dort fährt Tab normal durch die Seite.

---

## 6. Fehlerbehebung

- **Der Cursor steht nicht im Eingabefeld, nachdem ich den Chat geöffnet habe.** Klicke einmal ins Feld. Hast du das Modal per Zoom-Knopf geöffnet, prüfe, dass das Modal wirklich offen ist (Hintergrund abgedunkelt).
- **Escape hat den Chat nicht verkleinert.** Steht der Fokus nicht im Chat, reagiert der Chat nicht. Klicke in den Chat, dann Escape. Im Modal genügt es, dass nichts anderes den Fokus hat.
- **Escape hat einen anderen Dialog geschlossen, der Chat ist aber gleich geblieben.** Das ist gewollt. Der andere Dialog hatte Vorrang.
- **Ich sehe keinen Zoom-Knopf in der Sprechblase.** Der Chat ist angedockt. Schliesse die Sprechblase mit ✕ und öffne sie neu, dann erscheint er im kleinen Fenster.
- **Das Modal hat sich nach dem Verkleinern des Fensters selbst geöffnet.** Das Fenster ist unter 1200 px schmal geworden. Der Chat zeigt sich dann als Modal, bis du ihn schliesst.

---

## 7. Für Entwickler

- Die reinen Regeln für Escape und Fokusfalle stehen in `frontend/src/app/features/chat/chat-focus.ts` (`handlesEscape`, `trapFocusTarget`). Sie kommen ohne DOM aus, die Tests sind in `chat-focus.spec.ts`.
- Escape-Behandlung: `ChatComponent.onKeydown` (`(document:keydown)`). Der Modal-Dialog (`shared/modal.component.ts`) und das Aufgaben-Menü (`agent-tasks.component.ts`) rufen `preventDefault` auf, wenn sie Escape selbst behandeln, damit der Chat die Taste liegen lässt.
- Die Sprechblase-Logik liegt in `chat-bubble.component.ts`; der Fokus geht beim Schliessen auf den Sprechblasen-Knopf.
- Die globale Regel `[hidden] { display: none !important; }` steht in `frontend/src/styles/01-base.css`. Der Zoom-Knopf wird im Chat zusätzlich mit `@if` gerendert, nicht nur mit `[hidden]`. Das Modal-Styling des Chats (`.chat-docked`, `.chat-bubble-panel`, `.chat-icon-button`) steht in `frontend/src/styles/11-chat.css`.
- Wer ein Element trotz `hidden` zeigen will, muss das Attribut entfernen, sonst gewinnt `hidden` immer.
- Tests: `frontend/src/app/features/chat/chat-focus.spec.ts` (Escape-Zuständigkeit, Fokusfalle). Fokus und Fokusfalle im Browser sind **nicht** getestet; siehe „Offen“.

---

## Offen

- **Printscreens fehlen.** Sie lassen sich nachholen, wenn die App lokal läuft: Sprechblase geschlossen und geöffnet, angedockt bei 1200 px oder mehr, Modal, und die Escape-Situation mit einem fremden Dialog.
- **Fokus, Fokusfalle und Escape im Browser sind nicht geprüft.** Abgesichert sind bisher nur die reinen Regeln (Unit-Tests) und Build/Typprüfung. Eine Prüfung von Hand oder ein E2E-Test (Tab im Modal, Andocken, Escape in einem fremden Dialog) steht aus.
- Die Tests wurden für dieses Kapitel nicht erneut ausgeführt.
