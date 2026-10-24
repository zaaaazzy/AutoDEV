import { Component, output } from '@angular/core';
import { ModalComponent } from '../../shared/modal.component.js';

@Component({
  selector: 'app-help-dialog',
  standalone: true,
  imports: [ModalComponent],
  templateUrl: './help-dialog.component.html',
  host: { style: 'display: contents' },
})
export class HelpDialogComponent {
  readonly closed = output<void>();
  readonly startTour = output<void>();

  protected readonly flow = [
    { icon: '💡', title: 'Idee', text: 'Ideen und Fotos im Ideationboard erfassen.' },
    { icon: '📋', title: 'Auftrag', text: 'Aus der Idee entsteht ein Entwicklungsauftrag.' },
    { icon: '🏁', title: 'Sprint', text: 'Aufträge einem Sprint zuweisen und diesen starten.' },
    { icon: '🤖', title: 'Agents', text: 'Agents setzen die Aufträge um und testen.' },
    { icon: '🐞', title: 'Bugs', text: 'Fehler werden erfasst und wieder eingeplant.' },
    { icon: '📄', title: 'Doku & Git', text: 'Sprint abschließen: Bericht, Doku und Git-Sicherung.' },
  ];

  protected readonly workflow = [
    {
      object: 'Idee',
      icon: '💡',
      steps: [
        {
          status: 'Idee',
          agent: null,
          rule: 'Nutzer erfasst die Idee. Der Worker lässt den Auftragsautor beim nächsten Zyklus Aufwand und Kosten schätzen.',
        },
        {
          status: 'In Abklärung',
          agent: null,
          rule: 'Nutzer und Kommentare klären offene Punkte. Status wird manuell gesetzt, auch nach einem Agent-Fehler.',
        },
        {
          status: 'Wird ausformuliert',
          agent: 'Auftragsautor',
          rule: 'Berücksichtigt die Kommentare und erstellt den Auftrag. Bei Fehler zurück auf „In Abklärung“.',
        },
        { status: 'Auftrag erstellt', agent: null, rule: 'Endzustand. Der Auftrag liegt im Backlog.' },
      ],
    },
    {
      object: 'Auftrag',
      icon: '📋',
      steps: [
        {
          status: 'Backlog',
          agent: null,
          rule: 'Nutzer weist einen Sprint zu, danach automatisch „Geplant“. Alternativ wählt er einen einzelnen Agent und startet ihn mit ▶.',
        },
        {
          status: 'Geplant',
          agent: 'Bug-Wächter',
          rule: 'Der Worker startet ihn, wenn der Sprint aktiv ist; dann laufen grundsätzlich alle Agents der Reihe nach. Manuell gestartet läuft nur der gewählte Agent (einmalig).',
        },
        {
          status: 'In Arbeit',
          agent: 'Entwickler',
          rule: 'Setzt den Auftrag um. Läuft alles durch, wird er „Erledigt“.',
        },
        {
          status: 'Erledigt',
          agent: 'Tester · Dokumentierer',
          rule: 'Tests bestanden, Doku und Handbuch werden nachgeführt.',
        },
        { status: 'Blockiert', agent: null, rule: 'Ein Agent ist fehlgeschlagen. Nutzer prüft und plant neu.' },
      ],
    },
    {
      object: 'Sprint',
      icon: '🏁',
      steps: [
        {
          status: 'Geplant → Aktiv → Abgeschlossen',
          agent: null,
          rule: 'Nutzer startet und beendet Sprints manuell. Agents ändern den Sprint-Status nie.',
        },
      ],
    },
    {
      object: 'Bug',
      icon: '🐞',
      steps: [
        { status: 'Offen', agent: 'Bug-Wächter', rule: 'Prüft vor einem Auftrag offene Bugs und plant sie ein.' },
        { status: 'Behoben / Kein Fix', agent: null, rule: 'Nutzer setzt den Endstatus.' },
      ],
    },
  ];
}
