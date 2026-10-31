import type { ApiService } from '../../core/api.service.js';
import type { TourService, TourStep } from './tour.service.js';
import { DEVELOPMENT_STATUS, SPRINT_STATUS } from '../../core/models.js';

const CREATE_BUTTON = '.page-heading .page-create';

/** Erste Schritte: Ideation → Aufträge → Sprint → Board → Sprint starten → Agent live beobachten. */
export function firstStepsTour(api: ApiService): TourStep[] {
  const startSprint = async (tour: TourService): Promise<void> => {
    const data = tour.store.data();
    // Läuft schon ein Sprint, gibt es nichts zu starten – einfach weiter.
    if (data.sprints.some((sprint) => sprint.status === SPRINT_STATUS.active)) {
      tour.next();
      return;
    }
    // Starten lassen sich nur geplante Sprints, und nur mit geplanten Aufträgen.
    const sprint = data.sprints.find(
      (entry) =>
        entry.status === 'planned' &&
        data.development.some((item) => item.sprintId === entry.id && item.status === DEVELOPMENT_STATUS.planned),
    );
    if (!sprint) {
      tour.store.notice.set(
        data.sprints.some((entry) => entry.status === 'planned')
          ? 'Ziehe zuerst Aufträge in deinen geplanten Sprint.'
          : 'Lege zuerst einen Sprint an und ziehe Aufträge hinein.',
      );
      return;
    }
    // perform meldet Fehler selbst und wirft nicht – darum merken, ob der Start geklappt hat.
    let started = false;
    await tour.store.perform(async () => {
      const response = await api.patch(`/api/sprints/${encodeURIComponent(sprint.id)}`, { status: 'active' });
      started = true;
      return response;
    }, `Sprint „${sprint.name}“ läuft – die Agents legen los.`);
    if (started) tour.next();
  };

  return [
    {
      id: 'navigation',
      section: 'dashboard',
      targets: ['.sidebar nav', '.menu-toggle'],
      title: 'Willkommen in AIdeation',
      text: 'Links (auf dem Handy hinter dem Logo) findest du alle Bereiche. Wir gehen sie einmal gemeinsam durch – vom Einfall bis zum Agent, der ihn umsetzt.',
    },
    {
      id: 'ideation',
      section: 'ideation',
      target: CREATE_BUTTON,
      title: 'Ideen sammeln',
      text: 'Unter Ideation hältst du Einfälle fest – kurz und formlos. Lege jetzt eine Idee an oder tippe auf „Weiter“.',
    },
    {
      id: 'ideation-define',
      section: 'ideation',
      target: '.dt-table',
      title: 'Auftrag erstellen lassen',
      text: 'Bei jeder Idee kannst du die Auftragsbeschreibung vom Auftragsautor erstellen lassen. Er schreibt Ziel, Anforderungen und prüfbare Akzeptanzkriterien – du siehst ihn danach unter „Aufträge → In Entstehung“.',
    },
    {
      id: 'orders',
      section: 'development',
      target: CREATE_BUTTON,
      title: 'Aufträge',
      text: 'Aufträge kannst du auch direkt anlegen. Fehlgeschlagene oder aus dem Sprint genommene Aufträge landen im Menü unter „Aktionen“.',
    },
    {
      id: 'sprint-create',
      section: 'sprints',
      target: CREATE_BUTTON,
      title: 'Sprint anlegen',
      text: 'Ein Sprint bündelt die Aufträge, die als Nächstes umgesetzt werden. Lege einen an, falls noch keiner existiert.',
    },
    {
      id: 'sprint-open',
      section: 'sprints',
      target: '.sprint-current',
      title: 'Dein Sprint',
      text: 'Oben steht immer der aktuelle Sprint – mit allen seinen Aufträgen, nach Stand eingeordnet.',
      // Weiter, sobald die Auftragsliste des Sprints sichtbar ist.
      waitFor: () => {
        const list = document.querySelector('.sprint-current .sprint-orders');
        return Boolean(list && list.getBoundingClientRect().height > 0);
      },
      waitHint: 'Lege oben einen Sprint an …',
    },
    {
      id: 'board',
      section: 'sprints',
      target: '.sprint-current .sprint-pool',
      title: 'Aufträge in den Sprint nehmen',
      text: 'Unter „Aufträge hinzufügen“ holst du offene Aufträge mit → in den Sprint (oder mehrere per Häkchen). Die Reihenfolge unter „Geplant“ bestimmt, was die Agents zuerst abarbeiten – einer nach dem anderen; mit ↑/↓ änderst du sie.',
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
      target: '.sprint-current .sprint-orders',
      title: 'Sprint starten?',
      text: 'Wenn „Geplant“ Aufträge enthält, kannst du den Sprint jetzt starten. Der Worker übernimmt sofort den ersten Auftrag.',
      action: { label: 'Sprint jetzt starten', run: startSprint },
    },
    {
      id: 'agent-starts',
      targets: ['.worker-status', '.agents-chip'],
      shape: 'circle',
      title: 'Ein Agent beginnt',
      text: 'Gleich übernimmt ein Agent den ersten Auftrag. Er arbeitet im eigenen Arbeitscontainer deines Projekts – beim allerersten Auftrag richtet AIdeation diesen erst ein, das kann einige Minuten dauern. Hier oben siehst du jederzeit, wie viele Agents arbeiten.',
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
      text: 'Hier siehst du jeden Schritt: was gelesen, geschrieben und ausgeführt wird. Fertige Aufträge prüfen Tester und Reviewer – bei Fragen meldet sich AIdeation per Push. Viel Freude!',
    },
  ];
}
