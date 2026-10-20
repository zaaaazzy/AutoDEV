import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { AcceptanceCheck, DevelopmentItem, Estimate } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ConfirmService } from '../../core/confirm.service.js';
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

  /** Review-Freigabe: Auftrag freigeben – der Worker mergt ihn in den Sprint-Branch und zieht die Vorschau nach. */
  async approve(item: DevelopmentItem): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/approve`),
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

  /** Diesen Auftrag in der Review-Instanz zeigen (bzw. nach einem Fehlstart neu starten). */
  async showReview(item: DevelopmentItem): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/show-review`),
      'Review-Instanz wechselt – das dauert einen Moment.',
      false,
    );
  }

  async removeFromSprint(item: DevelopmentItem): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/remove-from-sprint`),
      'Auftrag aus dem Sprint genommen – er steht jetzt unter „Aktionen“.',
    );
  }

  async remove(item: DevelopmentItem): Promise<void> {
    if (!globalThis.confirm(`Auftrag „${item.title}“ endgültig löschen? Das lässt sich nicht rückgängig machen.`))
      return;
    await this.store.perform(
      () => this.api.delete(`/api/development/${encodeURIComponent(item.id)}`),
      'Auftrag gelöscht.',
    );
  }

  async confirmChecks(item: DevelopmentItem): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/acceptance/confirm`),
      'Danke – die Punkte sind als geprüft vermerkt.',
    );
  }

  /** Einzelnen Abnahmepunkt abhaken oder wieder öffnen. */
  async checkPoint(item: DevelopmentItem, check: AcceptanceCheck, checked: boolean): Promise<void> {
    await this.store.perform(
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
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/analyze`),
      'Der Assistent analysiert den Auftrag.',
    );
  }

  async startWithAgent(item: DevelopmentItem, agentId: string): Promise<void> {
    await this.store.perform(
      () => this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { agentId }),
      'Agent gestartet – der Worker übernimmt beim nächsten Zyklus.',
    );
  }
}
