import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Project, ProductionSnippets, ProductionStatus } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { DateTimePipe } from '../../shared/pipes.js';
import { logScanSummary } from './log-scan.js';

const TOKEN_PLACEHOLDER = '<TOKEN>';

/**
 * Projekt-Einstellungen des Produktions-Rückkanals: Health-URL, Compose-Dienste, Ausschlussmuster, Aufbewahrung und
 * Ingest-Token (Erzeugen/Rotieren; der Klartext erscheint nur direkt danach) samt kopierbaren Snippets.
 */
@Component({
  selector: 'app-production-settings',
  standalone: true,
  imports: [FormsModule, DateTimePipe],
  templateUrl: './production-settings.component.html',
  host: { style: 'display: contents' },
})
export class ProductionSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly busy = this.store.busy;
  protected form = { healthUrl: '', logServices: '', productionIgnore: '', productionRetentionDays: 30 };
  protected readonly status = signal<ProductionStatus | null>(null);
  protected readonly snippets = signal<ProductionSnippets | null>(null);
  protected readonly logScan = computed(() => logScanSummary(this.status()));
  /** Frisch erzeugtes Token: nur bis zum Verlassen der Seite sichtbar. */
  protected readonly token = signal<string | null>(null);
  protected readonly copied = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.store.foregroundLoads();
      const slug = this.store.activeProject();
      untracked(() => {
        this.token.set(null);
        this.fill();
        void this.load(slug);
      });
    });
  }

  private fill(): void {
    const project = this.store.currentProject();
    this.form = {
      healthUrl: project?.healthUrl ?? '',
      logServices: (project?.logServices ?? []).join(', '),
      productionIgnore: (project?.productionIgnore ?? []).join('\n'),
      productionRetentionDays: project?.productionRetentionDays ?? 30,
    };
  }

  private async load(slug: string): Promise<void> {
    if (!slug) return;
    try {
      const result = await this.api.get<{ production: ProductionStatus; snippets: ProductionSnippets }>(
        `${this.api.projectPath(slug)}/production`,
      );
      if (!this.store.isActive(slug)) return;
      this.status.set(result.production);
      this.snippets.set(result.snippets);
    } catch {
      if (this.store.isActive(slug)) this.status.set(null);
    }
  }

  /** Mit frischem Token eingesetzt, sonst mit Platzhalter. */
  protected withToken(text: string): string {
    const token = this.token();
    return token ? text.replaceAll(TOKEN_PLACEHOLDER, token) : text;
  }

  protected async save(): Promise<void> {
    const slug = this.store.activeProject();
    await this.store.perform(
      async () => {
        const result = await this.api.patch<{ project: Project }>(this.api.projectPath(slug), {
          healthUrl: this.form.healthUrl.trim(),
          logServices: this.form.logServices,
          productionIgnore: this.form.productionIgnore,
          productionRetentionDays: Number(this.form.productionRetentionDays),
        });
        this.store.projects.update((projects) =>
          projects.map((project) => (project.slug === slug ? { ...project, ...result.project } : project)),
        );
        await this.load(slug);
      },
      'Betriebs-Einstellungen gespeichert.',
      false,
    );
  }

  protected async createToken(): Promise<void> {
    const slug = this.store.activeProject();
    const rotate = this.store.currentProject()?.ingestConfigured;
    if (rotate && !globalThis.confirm('Neues Token erzeugen? Das bisherige gilt danach nicht mehr.')) return;
    await this.store.perform(
      async () => {
        const result = await this.api.post<{ token: string }>(`${this.api.projectPath(slug)}/ingest-token`);
        this.token.set(result.token);
        this.store.projects.update((projects) =>
          projects.map((project) => (project.slug === slug ? { ...project, ingestConfigured: true } : project)),
        );
        await this.load(slug);
      },
      rotate ? 'Token rotiert – das alte gilt nicht mehr.' : 'Token erzeugt.',
      false,
    );
  }

  protected async removeToken(): Promise<void> {
    const slug = this.store.activeProject();
    if (!globalThis.confirm('Token entfernen? Der Ingest-Endpunkt nimmt danach keine Meldungen mehr an.')) return;
    await this.store.perform(
      async () => {
        await this.api.delete(`${this.api.projectPath(slug)}/ingest-token`);
        this.token.set(null);
        this.store.projects.update((projects) =>
          projects.map((project) => (project.slug === slug ? { ...project, ingestConfigured: false } : project)),
        );
        await this.load(slug);
      },
      'Token entfernt.',
      false,
    );
  }

  protected async copy(key: string, text: string): Promise<void> {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      this.copied.set(key);
      globalThis.setTimeout(() => this.copied.set(null), 2000);
    } catch {
      this.copied.set(null);
    }
  }
}
