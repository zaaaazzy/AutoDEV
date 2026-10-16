import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { DevelopmentItem, Estimate } from '../../core/models.js';
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
    await this.store.perform(() => this.api.patch(`/api/development/${encodeURIComponent(id)}`, values), 'Auftrag aktualisiert.');
  }

  async save(item: DevelopmentItem, values: FormValues): Promise<void> {
    await this.store.perform(() => this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, {
      title: String(values['title'] ?? ''),
      description: String(values['description'] ?? ''),
      priority: values['priority'],
      ...estimateValues(values),
    }), 'Auftrag gespeichert.');
  }

  async retry(item: DevelopmentItem): Promise<void> {
    await this.store.perform(() => this.api.post(`/api/development/${encodeURIComponent(item.id)}/retry`), 'Auftrag wird erneut versucht.');
  }

  async analyze(item: DevelopmentItem): Promise<void> {
    await this.store.perform(() => this.api.post(`/api/development/${encodeURIComponent(item.id)}/analyze`), 'Der Assistent analysiert den Auftrag.');
  }

  async startWithAgent(item: DevelopmentItem, agentId: string): Promise<void> {
    await this.store.perform(
      () => this.api.patch(`/api/development/${encodeURIComponent(item.id)}`, { agentId }),
      'Agent gestartet – der Worker übernimmt beim nächsten Zyklus.',
    );
  }
}
