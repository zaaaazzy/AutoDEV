import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { AcceptanceCheck, DevelopmentItem, Estimate } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ConfirmService, type ConfirmOptions } from '../../core/confirm.service.js';
import { GitGuardService } from '../../core/git-guard.service.js';
import { retryComment } from '../../shared/attention-card.js';
import { numberOrNull, type FormValues } from '../../shared/forms.js';

function estimateValues(values: FormValues): Estimate {
  return {
    effortHours: numberOrNull(values['effortHours']),
    tokenEstimate: numberOrNull(values['tokenEstimate']),
    benefit: numberOrNull(values['benefit']),
    cost: numberOrNull(values['cost']),
  };
}

/** Aktionen auf einzelnen Aufträgen, genutzt von der Auftragsliste und der Detailansicht. */
@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  private readonly confirm = inject(ConfirmService);
  private readonly gitGuard = inject(GitGuardService);

  /** Jede Aktion auf einem Auftrag erst nach Rückfrage im globalen Dialog; ohne Kommentarfeld. */
  private async sure(options: Omit<ConfirmOptions, 'withoutComment'>): Promise<boolean> {
    return !!(await this.confirm.ask({ ...options, withoutComment: true }));
  }

  async update(id: string, values: Partial<DevelopmentItem>): Promise<void> {
    await this.store.perform(
      () => this.api.patch(`/api/development/${encodeURIComponent(id)}`, values),
      'Auftrag aktualisiert.',
    );
  }

  async save(item: DevelopmentItem, values: FormValues): Promise<void> {
    await this.store.perform(
      () =>
        this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, {
          title: String(values['title'] ?? ''),
          description: String(values['description'] ?? ''),
          priority: values['priority'],
          category: values['category'] || null,
          ...estimateValues(values),
        }),
      'Auftrag gespeichert.',
    );
  }

  /** Neuer Auftrag mit Bezug auf einen erledigten; der Entwickler bekommt dessen Kontext mit. */
  async followUp(
    item: DevelopmentItem,
    values: { title: string; description: string; sprintId: string | null },
  ): Promise<string | null> {
    let created: string | null = null;
    await this.store.perform(
      async () => {
        const result = await this.api.post<{ item: DevelopmentItem }>(
          `/api/development/${encodeURIComponent(item.id)}/follow-up`,
          values,
        );
        created = result.item.id;
      },
      values.sprintId
        ? 'Folgeauftrag erstellt und im Sprint eingeplant.'
        : 'Folgeauftrag erstellt – weise ihn einem Sprint zu.',
    );
    return created;
  }

  /**
   * Mehrere Aufträge auf einmal erneut versuchen bzw. wieder einplanen: eine Rückfrage, ein gemeinsamer Hinweis für
   * die Agents, dann je Auftrag die Route /retry. Nicht übernommene nennt die Meldung danach mit Titel.
   */
  async retryMany(items: DevelopmentItem[]): Promise<void> {
    if (!items.length) return;
    const titles = items.map((item) => `„${item.title}“`);
    const answer = await this.confirm.ask({
      title: `${items.length} ${items.length === 1 ? 'Auftrag' : 'Aufträge'} erneut versuchen?`,
      message: 'Die Aufträge werden wieder eingeplant; der Worker übernimmt sie nacheinander.',
      details: titles.length > 8 ? [...titles.slice(0, 8), `… und ${titles.length - 8} weitere`] : titles,
      confirmLabel: 'Erneut versuchen',
      commentLabel: 'Hinweis für die Agents (optional, gilt für alle)',
      commentPlaceholder: 'z. B. „Der Arbeitsordner ist aufgeräumt – einfach neu starten.“',
      commentHint: 'Wird mit Datum an die Beschreibung jedes Auftrags angehängt.',
    });
    if (!answer) return;
    await this.forEach(items, 'erneut eingeplant', (item) =>
      this.api.post(`/api/development/${encodeURIComponent(item.id)}/retry`, { comment: answer.comment }),
    );
  }

  /** Priorität mehrerer Aufträge setzen (ohne Rückfrage: lässt sich jederzeit zurückstellen). */
  async setPriorityMany(items: DevelopmentItem[], priority: DevelopmentItem['priority']): Promise<void> {
    await this.forEach(items, 'aktualisiert', (item) =>
      this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { priority }),
    );
  }

  /** Sammelaktion: nacheinander je Auftrag, ein Nachladen am Ende; Fehlschläge werden gesammelt gemeldet. */
  private async forEach(
    items: DevelopmentItem[],
    done: string,
    action: (item: DevelopmentItem) => Promise<unknown>,
  ): Promise<void> {
    const failed: string[] = [];
    await this.store.perform(
      async () => {
        for (const item of items) await action(item).catch(() => failed.push(item.title));
      },
      `${items.length} ${items.length === 1 ? 'Auftrag' : 'Aufträge'} ${done}.`,
    );
    if (failed.length)
      this.store.notice.set(
        `${items.length - failed.length} von ${items.length} ${done} – nicht möglich bei: ${failed.join(', ')}.`,
      );
  }

  /** Erneut versuchen bzw. wieder einplanen – erst nach Bestätigung, optional mit Hinweis für die Agents. */
  async retry(item: DevelopmentItem): Promise<void> {
    const blocked = item.status === 'blocked';
    const answer = await this.confirm.ask({
      title: blocked
        ? 'Auftrag erneut versuchen?'
        : item.status === 'rejected'
          ? 'Angepassten Auftrag erneut versuchen?'
          : 'Auftrag wieder einplanen?',
      message: `„${item.title}“ wird wieder eingeplant; der Worker übernimmt ihn beim nächsten Zyklus.`,
      details: [
        blocked
          ? 'Bereits bestandene Agents werden übersprungen; lehnten Tester oder Reviewer ab, beginnt es beim Entwickler.'
          : 'Der Auftrag durchläuft alle Agents.',
      ],
      confirmLabel: blocked ? 'Erneut versuchen' : 'Einplanen',
      commentLabel: 'Hinweis für die Agents (optional)',
      commentPlaceholder: 'z. B. „Der Test schlägt wegen der Zeitzone fehl – bitte UTC verwenden.“',
      commentHint: 'Wird mit Datum an die Beschreibung des Auftrags angehängt und so allen Agents mitgegeben.',
    });
    if (!answer) return;
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/retry`, { comment: answer.comment }),
      blocked ? 'Auftrag wird erneut versucht.' : 'Auftrag ist wieder eingeplant.',
    );
  }

  /**
   * Erneut versuchen bzw. wieder einplanen aus „Aktionen“: Der Dialog zeigt den Vorschlag der Analyse und hat die
   * schon eingetippte Ergänzung vorbelegt. Beides geht gemeinsam mit Datum an die Beschreibung, damit alle Agents es
   * sehen – die Ergänzung ersetzt den Vorschlag nicht. Liefert false, wenn abgebrochen wurde.
   */
  async retryNow(
    item: DevelopmentItem,
    options: { label: string; note: string; suggestion?: string | null },
  ): Promise<boolean> {
    const blocked = item.status === 'blocked';
    const answer = await this.confirm.ask({
      title: `${options.label}?`,
      message: `„${item.title}“ wird ${blocked ? 'erneut versucht' : 'wieder eingeplant'}; der Worker übernimmt ihn beim nächsten Zyklus.`,
      details: options.suggestion ? [`Vorschlag der Analyse: ${options.suggestion}`] : undefined,
      confirmLabel: options.label,
      commentLabel: 'Ergänzung für die Agents (optional)',
      commentPlaceholder: 'z. B. „Nur das Skript anpassen, den npm-Cache lassen.“',
      commentHint: options.suggestion
        ? 'Vorschlag und Ergänzung werden mit Datum an die Beschreibung des Auftrags angehängt.'
        : 'Wird mit Datum an die Beschreibung des Auftrags angehängt und so allen Agents mitgegeben.',
      initialComment: options.note,
    });
    if (!answer) return false;
    const comment = retryComment(
      { step: options.suggestion ? 'suggestion' : 'retry', detail: options.suggestion ?? null },
      answer.comment,
    );
    await this.store.perform(
      () =>
        this.api.post(`/api/development/${encodeURIComponent(item.id)}/retry`, {
          comment: comment?.trim() || undefined,
        }),
      item.status === 'blocked'
        ? comment?.trim()
          ? 'Antwort übernommen – der Auftrag läuft erneut.'
          : 'Auftrag wird erneut versucht.'
        : 'Auftrag ist wieder eingeplant.',
    );
    return true;
  }

  /** Review-Freigabe: Auftrag freigeben – der Worker mergt ihn in den Sprint-Branch und zieht die Vorschau nach. */
  async approve(item: DevelopmentItem): Promise<void> {
    // Gemergt wird im Ordner der Agents: Liegt dort Fremdes, fragt der Dialog mit Warnung und Begründung nach.
    const answer = await this.gitGuard.confirmAction(
      'approve',
      {
        title: 'Auftrag freigeben?',
        message: `„${item.title}“ wird in den Sprint-Branch gemergt; die Vorschau zieht danach nach.`,
        confirmLabel: 'Freigeben',
        withoutComment: true,
      },
      'Trotzdem freigeben',
    );
    if (!answer) return;
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/approve`, answer.body),
      'Freigegeben – wird gleich gemergt.',
    );
  }

  /** Review-Freigabe: zurück an die Agents, mit Rückmeldung (Pflicht). */
  async rejectReview(item: DevelopmentItem): Promise<void> {
    const answer = await this.confirm.ask({
      title: 'Auftrag zurückweisen?',
      message: `„${item.title}“ geht zurück an die Agents und wird auf seinem Branch nachgebessert.`,
      details: ['Danach wartet er wieder auf deine Freigabe.'],
      confirmLabel: 'Zurückweisen',
      commentLabel: 'Was passt nicht? (Pflicht)',
      commentRequired: true,
      commentPlaceholder: 'z. B. „Der Speichern-Knopf ist auf dem Handy abgeschnitten.“',
      commentHint: 'Wird mit Datum an die Beschreibung des Auftrags angehängt und so allen Agents mitgegeben.',
    });
    if (!answer) return;
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/review-reject`, { comment: answer.comment }),
      'Zurückgewiesen – die Agents bessern nach.',
    );
  }

  /**
   * Diesen Auftrag in der Review-Instanz zeigen (bzw. nach einem Fehlstart neu starten); mit `slot` in genau dieser
   * Umgebung (optische Abnahme). Liefert true, wenn der Start angefordert wurde.
   */
  async showReview(item: DevelopmentItem, slot?: number): Promise<boolean> {
    const where = slot ? `Umgebung ${slot}` : 'Ein Review-Container';
    const ok = await this.sure({
      title: slot ? `In Umgebung ${slot} laden?` : 'Im Review-Container anzeigen?',
      message: `${where} startet „${item.title}“ – ein belegter Container wechselt dafür den Auftrag.`,
      confirmLabel: slot ? 'Laden' : 'Anzeigen',
    });
    if (!ok) return false;
    let started = false;
    await this.store.perform(
      async () => {
        await this.api.post(`/api/development/${encodeURIComponent(item.id)}/show-review`, slot ? { slot } : undefined);
        started = true;
      },
      'Review-Instanz wechselt – das dauert einen Moment.',
      false,
    );
    return started;
  }

  async removeFromSprint(item: DevelopmentItem): Promise<void> {
    const ok = await this.sure({
      title: 'Aus dem Sprint nehmen?',
      message: `„${item.title}“ verlässt den Sprint und steht danach unter „Aktionen“.`,
      confirmLabel: 'Aus dem Sprint nehmen',
    });
    if (!ok) return;
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/remove-from-sprint`),
      'Auftrag aus dem Sprint genommen – er steht jetzt unter „Aktionen“.',
    );
  }

  async remove(item: DevelopmentItem): Promise<void> {
    const ok = await this.sure({
      title: 'Auftrag löschen?',
      message: `„${item.title}“ wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.`,
      confirmLabel: 'Endgültig löschen',
      danger: true,
    });
    if (!ok) return;
    await this.store.perform(
      () => this.api.delete(`/api/development/${encodeURIComponent(item.id)}`),
      'Auftrag gelöscht.',
    );
  }

  async confirmChecks(item: DevelopmentItem): Promise<void> {
    const ok = await this.sure({
      title: 'Alles geprüft?',
      message: `Die offenen Punkte von „${item.title}“ werden als von dir geprüft vermerkt.`,
      confirmLabel: 'Geprüft – alles in Ordnung',
    });
    if (!ok) return;
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/acceptance/confirm`),
      'Danke – die Punkte sind als geprüft vermerkt.',
    );
  }

  /** Einzelnen Abnahmepunkt abhaken oder wieder öffnen; false bei Fehler (403, 409, Netz). */
  checkPoint(item: DevelopmentItem, check: AcceptanceCheck, checked: boolean): Promise<boolean> {
    return this.store.perform(
      () =>
        this.api.post(`/api/development/${encodeURIComponent(item.id)}/acceptance/check`, {
          kind: check.kind,
          position: check.position,
          checked,
        }),
      checked ? 'Punkt abgehakt.' : 'Punkt wieder offen.',
    );
  }

  /** Offene Punkte (oder einen) vom Tester-Agent automatisch prüfen lassen. */
  async verifyPoints(item: DevelopmentItem, check?: AcceptanceCheck): Promise<void> {
    const ok = await this.sure({
      title: check ? 'Punkt vom Tester prüfen lassen?' : 'Offene Punkte vom Tester prüfen lassen?',
      message: check
        ? `Der Tester-Agent prüft „${check.text}“ automatisch.`
        : `Der Tester-Agent prüft die offenen Punkte von „${item.title}“ automatisch.`,
      confirmLabel: 'Prüfen lassen',
    });
    if (!ok) return;
    await this.store.perform(
      () =>
        this.api.post(
          `/api/development/${encodeURIComponent(item.id)}/acceptance/verify`,
          check ? { kind: check.kind, position: check.position } : {},
        ),
      'Der Tester prüft die offenen Punkte – das Ergebnis erscheint hier.',
    );
  }

  async analyze(item: DevelopmentItem): Promise<void> {
    const ok = await this.sure({
      title: 'Neu analysieren?',
      message: `Der Assistent analysiert „${item.title}“ erneut und schlägt eine Lösung vor.`,
      confirmLabel: 'Analysieren',
    });
    if (!ok) return;
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/analyze`),
      'Der Assistent analysiert den Auftrag.',
    );
  }

  async startWithAgent(item: DevelopmentItem, agentId: string, agentName?: string): Promise<void> {
    const ok = await this.sure({
      title: 'Agent starten?',
      message: `${agentName ? `„${agentName}“` : 'Der gewählte Agent'} übernimmt „${item.title}“ beim nächsten Zyklus des Workers.`,
      confirmLabel: 'Starten',
    });
    if (!ok) return;
    await this.store.perform(
      () => this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { agentId }),
      'Agent gestartet – der Worker übernimmt beim nächsten Zyklus.',
    );
  }
}
