# Angedockter Chat: Fokus, Zoom-Knopf und Escape

Auftrag 9e136e05 (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

- Beim Andocken wird die Sprechblase ausgeblendet, der Fokus fiel auf `body`. Das Modal setzte keinen Anfangsfokus, hatte keine Fokusfalle und gab den Fokus nicht zurück.
- Der Zoom-Knopf blieb trotz `[hidden]` sichtbar, weil `.chat-icon-button { display: inline-grid }` die Browser-Regel für `[hidden]` überschrieb. Ein Klick erzeugte das kleine zweite Fenster, das Commit `f2b532f` vermeiden wollte.
- Jedes Escape auf der Seite dockte den Chat ab, auch das Schliessen eines fremden Dialogs.

## Umsetzung (`frontend/src/`)

- `styles/01-base.css`: globale Regel `[hidden] { display: none !important; }`. Sie behebt dasselbe Muster auch in `sprint-proposal.component.html:29` und im Laufpanel. Der Zoom-Knopf im Chat selbst wird mit `@if` gerendert (`chat.component.html`).
- `features/chat/chat-focus.ts` (neu): reine Helfer ohne DOM.
  - `handlesEscape`: Escape gehört dem Chat nur, wenn er vergrössert ist, `defaultPrevented` nicht gesetzt ist und der Fokus im Chat liegt. Im Modal gilt das auch, wenn der Fokus auf `body`/`html` steht.
  - `trapFocusTarget`: Ziel für Tab/Shift+Tab am Rand des Modals (oder von ausserhalb).
- `features/chat/chat.component.ts`:
  - `(document:keydown)` → `onKeydown`: Escape (nur wenn zuständig, mit `preventDefault`) und Fokusfalle im Modal.
  - Das Eingabefeld wird nach dem Öffnen/Andocken fokussiert, im Modal erst nach dem Rendern (`afterNextRender`), damit der Fokus nicht auf einem versteckten Feld landet.
  - `unzoom()`: Beim Schliessen des Modals geht der Fokus dorthin zurück, wo er vorher war (sonst ins Eingabefeld).
- `features/chat/chat-bubble.component.ts`: Nach dem Schliessen (✕) bekommt die Sprechblase den Fokus zurück.
- `shared/modal.component.ts` und `features/chat/agent-tasks.component.ts`: behandeln Escape mit `preventDefault` und beachten `defaultPrevented`. So schliesst Escape zuerst den fremden Dialog bzw. das offene Aufgabenmenü, und der Chat dockt dabei nicht ab.

## Worauf zu achten ist

- Neue Escape-Empfänger auf Dokumentebene müssen `defaultPrevented` prüfen und die Taste mit `preventDefault` als behandelt markieren, sonst reagiert der Chat zusätzlich.
- Mit der globalen `[hidden]`-Regel gewinnt `hidden` immer gegen `display`. Wer ein Element absichtlich trotz `hidden` zeigen will, muss das Attribut entfernen.
- Fokus und Fokusfalle sind nur per Build/Typprüfung abgesichert, nicht in einem echten Browser. Ein E2E-Test oder eine manuelle Prüfung ist empfohlen (Tab im Modal, Andocken, Escape in einem fremden Dialog).

## Tests

- `features/chat/chat-focus.spec.ts`: Escape-Zuständigkeit (fremdes Ziel, `defaultPrevented`, Modal mit Fokus auf `body`) und Fokusfalle (Rand, ausserhalb, leer).
- Von der Dokumentation nicht erneut ausgeführt.

## Geänderte Dateien

- `frontend/src/app/features/chat/chat-focus.ts`, `chat-focus.spec.ts` (neu)
- `frontend/src/app/features/chat/chat.component.ts`, `chat.component.html`
- `frontend/src/app/features/chat/chat-bubble.component.ts`, `agent-tasks.component.ts`
- `frontend/src/app/shared/modal.component.ts`
- `frontend/src/styles/01-base.css`

## Offen für das Benutzerhandbuch

Beim Chat ergänzen: Nach dem Öffnen oder Andocken steht der Cursor im Eingabefeld; im Modal bleibt Tab im Chat; Escape dockt den Chat nur ab, wenn der Fokus im Chat liegt (oder das Modal offen ist); der Zoom-Knopf fehlt im angedockten Zustand.
