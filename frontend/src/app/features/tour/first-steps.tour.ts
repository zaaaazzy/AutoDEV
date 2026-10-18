import type { ApiService } from '../../core/api.service.js';
import type { TourService, TourStep } from './tour.service.js';

const CREATE_BUTTON = '.page-heading .actions .button.primary';

/** Erste Schritte: Ideation → Auftrag → Sprint → Board → Sprint starten → Agent live beobachten. */
export function firstStepsTour(api: ApiService): TourStep[] {
  const startSprint = async (tour: TourService): Promise<void> => {
    const data = tour.store.data();
    const candidates = data.sprints.filter((sprint) => sprint.status !== 'completed');
    const sprint =
      candidates.find((entry) =>
        data.development.some((item) => item.sprintId === entry.id && item.status === 'planned'),
      ) ?? candidates[0];
    if (!sprint) {
      tour.store.notice.set('Lege zuerst einen Sprint an und ziehe Aufträge hinein.');
      return;
    }
    await tour.store.perform(
      () => api.patch(`/api/sprints/${encodeURIComponent(sprint.id)}`, { status: 'active' }),
      `Sprint „${sprint.name}“ läuft – die Agents legen los.`,
    );
    tour.next();
  };

  return [
    {
      id: 'navigation',
      section: 'dashboard',
      targets: ['.sidebar nav', '.menu-toggle'],
      title: 'Willkommen in Dev Log',
      text: 'Links (auf dem Handy hinter dem Logo) findest du alle Bereiche. Wir gehen sie einmal gemeinsam durch – vom Einfall bis zum Agent, der ihn umsetzt.',
    },
    {
      id: 'ideation',
      section: 'ideation',
      target: CREATE_BUTTON,
      title: '1 · Ideen sammeln',
      text: 'Unter Ideation hältst du Einfälle fest – kurz und formlos. Lege jetzt eine Idee an oder tippe auf „Weiter“.',
    },
    {
      id: 'ideation-define',
      section: 'ideation',
      target: '.dt-table',
      title: 'Auftrag erstellen lassen',
      text: 'Bei jeder Idee kannst du die Auftragsbeschreibung vom Auftragsautor erstellen lassen. Er schreibt Ziel, Anforderungen und prüfbare Akzeptanzkriterien – du siehst ihn danach unter „Auftrag → In Entstehung“.',
    },
    {
      id: 'orders',
      section: 'development',
      target: CREATE_BUTTON,
      title: '2 · Aufträge',
      text: 'Aufträge kannst du auch direkt anlegen. Fehlgeschlagene oder aus dem Sprint genommene Aufträge landen oben unter „Besondere Aufmerksamkeit“.',
    },
    {
      id: 'sprint-create',
      section: 'sprints',
      target: CREATE_BUTTON,
      title: '3 · Sprint anlegen',
      text: 'Ein Sprint bündelt die Aufträge, die als Nächstes umgesetzt werden. Lege einen an, falls noch keiner existiert.',
    },
    {
      id: 'sprint-open',
      section: 'sprints',
      target: '.sprints .dt-table tbody tr .dt-expand',
      title: 'Sprint öffnen',
      text: 'Öffne den Sprint, um sein Board zu sehen.',
      // Weiter, sobald ein Board sichtbar ist – auch wenn der Sprint schon offen war.
      waitFor: () => {
        const board = document.querySelector('.kanban');
        return Boolean(board && board.getBoundingClientRect().height > 0);
      },
      waitHint: 'Tippe auf den Pfeil beim Sprint …',
    },
    {
      id: 'board',
      section: 'sprints',
      target: '.kanban',
      title: '4 · Aufträge in den Sprint ziehen',
      text: 'Ziehe Aufträge von „Offen“ nach „Geplant“ (oder tippe auf →). Die Reihenfolge in „Geplant“ bestimmt, was die Agents zuerst abarbeiten – einer nach dem anderen.',
    },
    {
      id: 'delete-hint',
      targets: ['a.nav-link[href="#settings"]', '.menu-toggle'],
      title: 'Gut zu wissen',
      text: 'Alles Ausprobierte lässt sich später wieder entfernen: Unter Einstellungen kannst du ein Projekt löschen – auf Wunsch samt Ordner auf deinem Rechner.',
    },
    {
      id: 'start-sprint',
      section: 'sprints',
      target: '.kanban .col-planned',
      title: '5 · Sprint starten?',
      text: 'Wenn „Geplant“ Aufträge enthält, kannst du den Sprint jetzt starten. Der Worker übernimmt sofort den ersten Auftrag.',
      action: { label: 'Sprint jetzt starten', run: startSprint },
    },
    {
      id: 'agent-starts',
      targets: ['.worker-status', '.agents-chip'],
      shape: 'circle',
      title: 'Ein Agent beginnt',
      text: 'Gleich übernimmt ein Agent den ersten Auftrag. Hier oben siehst du jederzeit, wie viele Agents arbeiten.',
      waitFor: (tour) => tour.store.worker().agents.some((agent) => agent.active),
      waitHint: 'Warte, bis der erste Agent startet …',
    },
    {
      id: 'agent-click',
      targets: ['.worker-status', '.agents-chip'],
      shape: 'circle',
      title: 'Schau ihm über die Schulter',
      text: 'Klicke auf den Agent-Status, um zu sehen, woran gerade gearbeitet wird.',
      waitFor: 'click',
      waitHint: 'Klicke auf den hervorgehobenen Kreis …',
    },
    {
      id: 'agent-live',
      section: 'agents',
      targets: ['.live-progress', 'app-order-table'],
      title: 'Live dabei',
      text: 'Hier siehst du jeden Schritt: was gelesen, geschrieben und ausgeführt wird. Fertige Aufträge prüfen Tester und Reviewer – bei Fragen meldet sich Dev Log per Push. Viel Freude!',
    },
  ];
}
