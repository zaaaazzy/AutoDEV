import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service.js';

export interface SetupJob<R = Record<string, unknown>> {
  id: string;
  kind: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result: (R & { error?: string }) | null;
  log: string;
}

const POLL_MS = 600;
const MAX_WAIT_MS = 15 * 60_000;
/** So lange darf der Server beim Abfragen des Fortschritts ausfallen (Neustart), bevor die Aufgabe als gescheitert gilt. */
const MAX_OUTAGE_MS = 60_000;

/** Startet Einrichtungsaufgaben, die der Worker auf dem Rechner ausführt, und wartet auf ihr Ergebnis. */
@Injectable({ providedIn: 'root' })
export class SetupService {
  private readonly api = inject(ApiService);

  async run<R = Record<string, unknown>>(
    kind: string,
    params: Record<string, unknown> = {},
    onUpdate?: (job: SetupJob<R>) => void,
  ): Promise<SetupJob<R>> {
    const { id } = await this.api.post<{ id: string }>('/api/setup/jobs', { kind, params });
    const started = Date.now();
    let failingSince: number | null = null;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      // Ein einzelner fehlgeschlagener Abruf (z. B. 502 beim Neustart) beendet das Warten nicht – der Job läuft im
      // Worker weiter. Erst wenn der Server länger nicht antwortet, gilt die Aufgabe als gescheitert.
      let job: SetupJob<R>;
      try {
        job = (await this.api.get<{ job: SetupJob<R> }>(`/api/setup/jobs/${encodeURIComponent(id)}`)).job;
        failingSince = null;
      } catch (error) {
        failingSince ??= Date.now();
        if (Date.now() - failingSince > MAX_OUTAGE_MS) throw error;
        continue;
      }
      onUpdate?.(job);
      if (job.status === 'done' || job.status === 'failed') return job;
      if (Date.now() - started > MAX_WAIT_MS) throw new Error('Die Aufgabe dauert zu lange – läuft der Worker?');
      if (job.status === 'pending' && Date.now() - started > 20_000) {
        throw new Error('Der Worker nimmt die Aufgabe nicht an – bitte prüfen, ob er läuft.');
      }
    }
  }
}
