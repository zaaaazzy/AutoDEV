# Benutzerhandbuch: Push-Abos nur für bekannte Dienste, nur für den Besitzer, beim Abmelden entfernt

Stand: 2026-10-29 · Auftrag `f230ad31` (Bugfix, Push-Abos) · Sprint 23

## Was sich für dich ändert

Push-Nachrichten gehen nur noch an Geräte, die über einen bekannten Push-Dienst des Browsers angemeldet sind. Außerdem
gehört jedes Gerät genau einem Konto, und beim Abmelden verschwindet das Gerät aus den Push-Empfängern.

- Der Server schickt keine Anfragen mehr an beliebige Adressen. Früher reichte jede `https://`-Adresse als Ziel.
- Ein Gerät, das schon einem anderen Konto gehört, lässt sich nicht mehr still übernehmen.
- Wer sich abmeldet, schaltet Push auf diesem Gerät ab: im Browser und auf dem Server.

Die Bedienung bleibt gleich. Die Schalter stehen an derselben Stelle, und Meldungen erscheinen wie bisher.

**Printscreens: fehlen.** Dieser Lauf konnte AIdeation nicht starten (Docker-Befehle und der lokale Zugriff sind für
Agents gesperrt). Die Beschreibung stammt aus dem Code der Oberfläche, nicht aus dem Bildschirm. Die Aufnahmen stehen
unter „Noch offen“.

## Wo du das findest

| Was | Wo in AIdeation | Sichtbar, wenn |
|---|---|---|
| Push-Nachrichten ein- und ausschalten | Einstellungen → App & Benachrichtigungen → Schalter „Push-Nachrichten“ | immer |
| Testnachricht senden | gleicher Bereich, Knopf „Testnachricht senden“ | Push auf diesem Gerät ist eingeschaltet |
| Abmelden | Einstellungen → Sicherheit → Knopf „Abmelden“ | Du bist mit Anmeldung (Passwort) angemeldet, nicht nur über die Zugangsdaten der `.env` |

## Was passiert

### Push einschalten

1. Schalter „Push-Nachrichten“ einschalten. Es erscheint die Anleitung „Benachrichtigungen erlauben“.
2. „Erlauben“ wählen. Der Browser fragt nach der Erlaubnis.
3. Bei Zustimmung meldet AIdeation das Gerät an und schickt eine Testnachricht.

Auf dem iPhone geht das nur, wenn AIdeation vorher als App auf dem Home-Bildschirm installiert ist. Die Anleitung
sagt das dann selbst.

### Push ausschalten

Der Schalter entfernt das Abo auf dem Server und im Browser. Danach kommen auf diesem Gerät keine Meldungen mehr.

### Testnachricht

- Die Testnachricht geht nur an deine eigenen Geräte. Andere Konten bekommen nichts davon.
- Ist kein Gerät angemeldet, lautet die Meldung „Kein Gerät angemeldet.“.

### Abmelden

1. Du wählst „Abmelden“ in Einstellungen → Sicherheit.
2. AIdeation meldet zuerst das Push-Abo dieses Geräts am Server und im Browser ab.
3. Danach wird die Sitzung beendet und die Seite neu geladen.

Wenn der Browser-Teil scheitert (zum Beispiel weil das Gerät keinen Service Worker hat), wird trotzdem abgemeldet. Der
Server löscht das Abo dann über den Endpunkt, den er beim Abmelden mitbekommt. Ein Fehler beim Push-Abo verhindert
das Abmelden also nie.

## Bedingungen

- **Erlaubte Dienste.** Ein Gerät wird nur angenommen, wenn die Adresse per `https://` ohne Zugangsdaten kommt und
  einer dieser Dienste ist:
  - Chrome und Edge: `fcm.googleapis.com`
  - Firefox: `updates.push.services.mozilla.com`
  - Safari (macOS und iOS): Unterdomänen von `push.apple.com`
  - Windows: Unterdomänen von `notify.windows.com`

  Die Adresse darf höchstens 1000 Zeichen lang sein. Ein eigener Port ist nicht erlaubt (Port 443 ist dasselbe wie
  kein Port).
- **Nur eigene Geräte.** Ein Gerät gehört dem Konto, das es angemeldet hat. Nur dieses Konto kann es ändern oder
  abmelden. Ohne eigenes Konto (Anmeldung über die Zugangsdaten der `.env`) gehören Geräte dem Systemadministrator.
- **Abgelehnte Geräte erscheinen nicht als Fehler für andere.** Wer ein Gerät anmeldet, das schon einem anderen Konto
  gehört, bekommt die Erfolgsmeldung. Das Gerät bleibt aber beim anderen Konto, und du bekommst dort keine Meldungen.
  Die Oberfläche kann das nicht anzeigen. Abhilfe: Auf diesem Gerät beim bisherigen Konto Push ausschalten oder dort
  abmelden, dann hier erneut einschalten.
- **Altgeräte werden entfernt.** Abos mit anderen Adressen (etwa aus der Zeit vor dieser Änderung) werden beim nächsten
  Senden nicht mehr angefragt und aus der Datenbank gelöscht. Das Gerät muss Push danach neu einschalten.
- **Meldungen an alle Geräte.** Auftrags- und Systemmeldungen gehen weiterhin an alle berechtigten Geräte. Die
  Empfängerregeln ändern sich nicht.

## Fehlermeldungen und Behebung

| Meldung | Ursache | Was tun |
|---|---|---|
| „Ungültige Push-Anmeldung.“ | Der Browser nutzt einen Push-Dienst, der nicht auf der Liste steht. Der Server lehnt das Abo ab. | Schalter „Push-Nachrichten“ ausschalten und wieder einschalten. Mit einem anderen Browser versuchen, wenn es sich wiederholt |
| „Benachrichtigungen wurden im Browser nicht erlaubt.“ | Die Erlaubnis wurde verweigert | Im Browser (Schloss-Symbol in der Adressleiste, bzw. Einstellungen auf dem iPhone) auf „Zulassen“ stellen und neu laden |
| „Kein Gerät angemeldet.“ | Auf keinem Gerät ist ein Abo für dein Konto gespeichert | Push auf diesem Gerät einschalten |
| Nach dem Abmelden kommen trotzdem Meldungen | Das Abo stammt von einer Abmeldung vor dieser Änderung, oder die Abmeldung ist nicht vollständig gelaufen | Mit dem Konto anmelden, dem das Gerät gehörte, Push ausschalten und abmelden. Sonst den Systemadministrator bitten, den Eintrag in `push_subscriptions` zu löschen |

Ein fehlgeschlagener Schritt beim Push-Abo verhindert die Anmeldung nie. Die Anmeldung selbst bleibt davon unberührt.

## Noch offen

- **Printscreens fehlen.** Für ein vollständiges Kapitel braucht es vier Aufnahmen:
  1. Einstellungen → App & Benachrichtigungen mit eingeschaltetem Schalter und Knopf „Testnachricht senden“
  2. Die Anleitung „Benachrichtigungen erlauben“
  3. Einstellungen → Sicherheit mit dem Knopf „Abmelden“
  4. Die Meldung „Kein Gerät angemeldet.“ nach einer Testnachricht ohne Abo
- **Tests nicht ausgeführt.** Ich habe die Tests für `src/api/push.test.ts`, `src/core/push.test.ts` und
  `push-logout.spec.ts` nicht gestartet. Die Beschreibung stammt aus dem Code und aus der Auftragsdokumentation.
- **Oberfläche nicht im Browser geprüft.** Ob die Abmeldung auf einem echten Gerät den Browser-Teil erledigt, ist
  nicht geprüft.
- **Auftragsnummer.** Die Dokumentation `docs/push-abos-ssrf-besitz-logout-2026-10-25.md` nennt den Auftrag
  `7ec815c1`. Dieses Kapitel nennt `f230ad31`, wie im Auftrag angegeben.

## Verwandte Dokumente

- [Entwicklerdoku zur Änderung](push-abos-ssrf-besitz-logout-2026-10-25.md)
- [Installation, Abschnitt Zugriff von unterwegs](../installation.md)
- [Benutzerhandbuch TOTP- und Push-Schlüssel verschlüsselt](benutzerhandbuch-totp-und-vapid-verschluesselt.md)
