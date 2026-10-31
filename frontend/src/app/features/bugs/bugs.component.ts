import { NgClass } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GithubLinkComponent } from '../../shared/github-link.component.js';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import { ConfirmService } from '../../core/confirm.service.js';
import type { Bug, BugStatus, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { errorMessage } from '../../core/errors.js';
import { assertImageSizes } from '../../shared/image-upload.js';
import { FieldErrors, focusField } from '../../shared/field-errors.js';
import type { FormValues } from '../../shared/forms.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { formatIsoDate } from '../../shared/format.js';
import { CATEGORIES, severityLabel, statusLabel } from '../../shared/labels.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import { GalleryComponent } from '../../shared/gallery.component.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { type BugStatRow, type BugStats, bugStats, isBuried } from './bug-stats.js';
import { ProductionDetailComponent } from './production-detail.component.js';
import { BURYING_STATUSES, EDIT_TITLE_MAX, SEVERITIES, bugChanges, selectableSprints } from './bug-form.js';
import {
  CategoryLabelPipe,
  SeverityLabelPipe,
  ShortTextPipe,
  StatusClassPipe,
  StatusLabelPipe,
} from '../../shared/pipes.js';

const SEVERITY_RANK = ['low', 'medium', 'high', 'critical'];
const BUG_STATUS_RANK = ['open', 'in_progress', 'fixed', 'wontfix', 'rejected'];

/** Pro Statistik-Karte höchstens so viele Zeilen, der Rest wird zusammengefasst. */
const STAT_ROWS = 10;

const BUG_SOURCE_LABEL: Record<string, string> = {
  agent: 'Agent',
  manual: 'Manuell',
  test: 'Testlauf',
  github: 'GitHub',
  production: 'Betrieb',
  routine: 'Routine',
};
@Component({
  selector: 'app-bugs',
  standalone: true,
  imports: [
    GithubLinkComponent,
    NgClass,
    FormsModule,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    GalleryComponent,
    ProductionDetailComponent,
    MarkdownPipe,
    SeverityLabelPipe,
    ShortTextPipe,
    StatusClassPipe,
    StatusLabelPipe,
    CategoryLabelPipe,
  ],
  templateUrl: './bugs.component.html',
  host: { style: 'display: contents' },
})
export class BugsComponent {
  private readonly api = inject(ApiService);
  private readonly confirm = inject(ConfirmService);
  private readonly auth = inject(AuthService);
  protected readonly store = inject(ProjectStore);
  /** Rechte wie in der API: Bearbeiten, Löschen und Sprint-Zuordnung „Planen“, Freigabe für Agents „Ausführen“. */
  protected readonly mayPlan = computed(() => this.auth.can('plan'));
  protected readonly mayRun = computed(() => this.auth.can('run'));
  protected readonly severities = SEVERITIES;
  protected readonly editTitleMax = EDIT_TITLE_MAX;
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly bugStatuses: BugStatus[] = ['open', 'in_progress', 'fixed', 'wontfix', 'rejected'];
  protected readonly openBug = signal<string | null>(null);
  protected readonly bugId = (bug: Bug): string => bug.id;
  protected readonly bugColumns: DataColumn<Bug>[] = [
    { id: 'title', header: 'Titel', value: (bug) => bug.title, filter: 'text', className: 'title-cell' },
    {
      id: 'status',
      header: 'Status',
      value: (bug) => statusLabel(bug.status),
      sortValue: (bug) => BUG_STATUS_RANK.indexOf(bug.status),
    },
    {
      id: 'severity',
      header: 'Schweregrad',
      value: (bug) => severityLabel(bug.severity),
      sortValue: (bug) => SEVERITY_RANK.indexOf(bug.severity),
    },
    // Kategoriefilter mit allen Kategorien und „Ohne Kategorie“; Zurücksetzen und Chips über die DataTable.
    categoryColumn<Bug>((bug) => bug.category, true),
    { id: 'source', header: 'Quelle', value: (bug) => BUG_SOURCE_LABEL[bug.source] ?? 'Manuell' },
    {
      id: 'sprint',
      header: 'Sprint',
      value: (bug) => this.sprintName(bug),
    },
    {
      id: 'createdAt',
      header: 'Erstellt',
      value: (bug) => formatIsoDate(bug.createdAt),
      sortValue: (bug) => bug.createdAt,
    },
  ];
  /** Auf dem Friedhof: wann begraben statt Sprint. */
  protected readonly buriedColumns: DataColumn<Bug>[] = [
    ...this.bugColumns.filter((column) => column.id !== 'sprint' && column.id !== 'createdAt'),
    {
      id: 'buriedAt',
      header: 'Begraben',
      value: (bug) => (bug.fixedAt ? formatIsoDate(bug.fixedAt) : '–'),
      sortValue: (bug) => bug.fixedAt ?? bug.createdAt,
    },
  ];
  protected readonly isBuried = isBuried;
  /** Oben nur offene Bugs (ist sonst deprimierend), darunter der Bug-Friedhof. */
  protected readonly lists = computed(() => {
    const bugs = this.data().bugs;
    return [
      {
        id: 'open',
        buried: false,
        rows: bugs.filter((bug) => !isBuried(bug)),
        empty: 'Keine offenen Bugs – alles ruht in Frieden.',
      },
      { id: 'buried', buried: true, rows: bugs.filter(isBuried), empty: 'Der Friedhof ist noch leer.' },
    ];
  });
  protected readonly statistics = computed(() => bugStats(this.data().bugs));

  protected statGroups(stats: BugStats) {
    const group = (title: string, column: string, rows: BugStatRow[], empty: string) => ({
      title,
      column,
      rows: rows.slice(0, STAT_ROWS),
      more: Math.max(0, rows.length - STAT_ROWS),
      max: Math.max(1, ...rows.map((row) => row.total)),
      empty,
    });
    return [
      group('Gefunden von', 'Wer', stats.finders, 'Noch keine Bugs.'),
      group('Wo', 'Seite / Bereich', stats.places, 'Noch keine Zuordnung.'),
      group('Nach Kategorie', 'Kategorie', stats.categories, 'Noch keine Bugs.'),
      group('In welchen Tests', 'Test', stats.tests, 'In den Berichten wird kein Test genannt.'),
    ];
  }

  protected readonly bugErrors = new FieldErrors();
  /** Fehler im Bearbeiten-Formular; es ist immer nur ein Bug aufgeklappt. */
  protected readonly editErrors = new FieldErrors();
  protected bugForm = { title: '', description: '', severity: 'medium', sprintId: '', category: '' };
  protected readonly categories = CATEGORIES;
  protected pendingImages: File[] = [];

  constructor() {
    // Link auf einen Bug (#bugs/<id>, z. B. aus einem Bericht): Zeile aufklappen und hinscrollen.
    effect(() => {
      const id = this.store.focusId();
      if (!id || !this.data().bugs.some((bug) => bug.id === id)) return;
      untracked(() => {
        this.openBug.set(id);
        globalThis.setTimeout(
          () => document.querySelector('.row-open')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
          200,
        );
      });
    });
  }

  protected toggleBug(id: string): void {
    this.showBug(this.openBug() === id ? null : id);
  }

  /** Aufklappen hält die Adresse aktuell (#bugs/<id>), damit sich der Bug als Link teilen lässt. */
  protected showBug(id: string | null): void {
    this.openBug.set(id);
    this.editErrors.clear();
    globalThis.history.replaceState(null, '', id ? `#bugs/${id}` : '#bugs');
  }

  protected sprintName(bug: Bug): string {
    return this.data().sprints.find((sprint) => sprint.id === bug.sprintId)?.name ?? 'Kein Sprint';
  }

  protected sprintsFor(currentId: string | null = null): Sprint[] {
    return selectableSprints(this.data().sprints, currentId);
  }

  protected async createBug(form: HTMLFormElement): Promise<void> {
    if (!this.bugErrors.require('title', this.bugForm.title, 'Bitte einen Titel angeben.')) {
      focusField(form, 'title');
      return;
    }
    const body = { ...this.bugForm, sprintId: this.bugForm.sprintId || null };
    const files = this.pendingImages;
    let uploadError = '';
    await this.store.perform(async () => {
      // Größe vorher prüfen: Ein zu großes Bild darf keinen Bug ohne Bild anlegen.
      assertImageSizes(files);
      const created = await this.api
        .post<{ bug: Bug }>(`${this.api.projectPath(this.store.activeProject())}/bugs`, body)
        .catch((error: unknown) => {
          this.bugErrors.take(error, form);
          throw error;
        });
      // Angelegt ist angelegt: Formular sofort leeren, damit ein zweiter Klick keinen doppelten Bug erzeugt.
      this.pendingImages = [];
      this.bugForm = { title: '', description: '', severity: 'medium', sprintId: '', category: '' };
      this.store.showCreate.set(false);
      uploadError = await this.uploadImages(created.bug.id, files).then(
        () => '',
        (error: unknown) => errorMessage(error, 'Upload fehlgeschlagen.'),
      );
    }, 'Bug wurde gemeldet.');
    if (uploadError) this.store.notice.set(`Bug wurde gemeldet, Bilder aber nicht: ${uploadError}`);
  }

  protected pendingImageNames(): string {
    return this.pendingImages.map((file) => file.name).join(', ');
  }

  protected selectPendingImages(input: HTMLInputElement): void {
    this.pendingImages = [...this.pendingImages, ...Array.from(input.files ?? [])];
    input.value = '';
  }

  protected async addImages(bugId: string, input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    await this.store.perform(
      () => this.uploadImages(bugId, files),
      files.length === 1 ? 'Bild angehängt.' : `${files.length} Bilder angehängt.`,
    );
  }

  private async uploadImages(bugId: string, files: File[]): Promise<void> {
    assertImageSizes(files);
    for (const file of files) {
      await this.api.upload(`/api/bugs/${encodeURIComponent(bugId)}/attachments`, file);
    }
  }

  protected async saveBug(bug: Bug, values: FormValues, form: HTMLFormElement): Promise<void> {
    if (!this.editErrors.require('title', String(values['title'] ?? ''), 'Bitte einen Titel angeben.')) {
      focusField(form, 'title');
      return;
    }
    const changes = bugChanges(bug, values);
    if (!Object.keys(changes).length) {
      this.store.notice.set('Keine Änderungen zum Speichern.');
      return;
    }
    await this.store.perform(
      () =>
        this.api.patch(`/api/bugs/${encodeURIComponent(bug.id)}`, changes).catch((error: unknown) => {
          this.editErrors.take(error, form);
          throw error;
        }),
      'Bug wurde gespeichert.',
    );
  }

  protected async updateBug(id: string, values: Partial<Bug>): Promise<void> {
    await this.store.perform(() => this.api.patch(`/api/bugs/${encodeURIComponent(id)}`, values), 'Bug aktualisiert.');
  }

  /** Behoben, Wird nicht behoben, Abgelehnt: Der Bug geht auf den Friedhof – vorher nachfragen. */
  protected async changeStatus(bug: Bug, select: HTMLSelectElement): Promise<void> {
    const status = select.value as BugStatus;
    if (status === bug.status) return;
    if (BURYING_STATUSES.has(status)) {
      const answer = await this.confirm.ask({
        title: 'Bug auf den Friedhof legen?',
        message: `„${bug.title}“ bekommt den Status „${statusLabel(status)}“ und verschwindet aus den offenen Bugs. Zurückholen lässt er sich nicht; taucht der Fehler wieder auf, als neuen Bug melden.`,
        confirmLabel: statusLabel(status),
        withoutComment: true,
      });
      if (!answer) {
        select.value = bug.status;
        return;
      }
    }
    await this.updateBug(bug.id, { status });
  }

  /** Bugs aus Betrieb oder GitHub enthalten fremden Text; Agents bearbeiten sie erst nach der Freigabe. */
  protected awaitsApproval(bug: Bug): boolean {
    return (bug.source === 'production' || bug.source === 'github') && !bug.approvedAt;
  }

  protected async approveBug(bug: Bug): Promise<void> {
    const answer = await this.confirm.ask({
      title: 'Bug für Agents freigeben?',
      message:
        'Die Beschreibung stammt aus einer fremden Quelle. Erst nach der Freigabe arbeiten Agents daran – vorher auf eingeschleuste Anweisungen prüfen.',
      details: [bug.title],
      confirmLabel: 'Geprüft, freigeben',
      withoutComment: true,
    });
    if (!answer) return;
    await this.store.perform(
      () => this.api.post(`/api/bugs/${encodeURIComponent(bug.id)}/approve`, {}),
      'Bug für Agents freigegeben.',
    );
  }

  protected async deleteBug(bug: Bug): Promise<void> {
    const answer = await this.confirm.ask({
      title: 'Bug löschen?',
      message: 'Der Bug wird endgültig gelöscht, samt Bildern und noch nicht begonnenem Auftrag.',
      details: [bug.title],
      confirmLabel: 'Löschen',
      withoutComment: true,
      danger: true,
    });
    if (!answer) return;
    await this.store.perform(async () => {
      await this.api.delete(`/api/bugs/${encodeURIComponent(bug.id)}`);
      if (this.openBug() === bug.id) this.showBug(null);
    }, 'Bug gelöscht.');
  }
}
