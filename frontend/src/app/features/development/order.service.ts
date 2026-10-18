import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { AcceptanceCheck, DevelopmentItem, Estimate } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
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

  async retry(item: DevelopmentItem): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/retry`),
      item.status === 'blocked' ? 'Auftrag wird erneut versucht.' : 'Auftrag ist wieder eingeplant.',
    );
  }

  async removeFromSprint(item: DevelopmentItem): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/development/${encodeURIComponent(item.id)}/remove-from-sprint`),
      'Auftrag aus dem Sprint genommen – er steht jetzt unter „Besondere Aufmerksamkeit“.',
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
