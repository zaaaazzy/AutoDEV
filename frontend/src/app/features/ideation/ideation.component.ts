import { OrderBriefComponent } from '../../shared/order-brief.component.js';
import { GithubLinkComponent } from '../../shared/github-link.component.js';
import { NgClass, NgTemplateOutlet } from '@angular/common';
import { Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import { ConfirmService } from '../../core/confirm.service.js';
import type { DevelopmentItem, Idea, Priority, Sprint, VisionaryRun } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { visibleInterval } from '../../core/visible-interval.js';
import {
  type DataColumn,
  DataActionsDirective,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { GalleryComponent } from '../../shared/gallery.component.js';
import { branchNode, commitNode, type GitNode, GitTreeComponent } from '../../shared/git-tree.component.js';
import { formatHours, formatIsoDate } from '../../shared/format.js';
import { CATEGORIES, priorityLabel, statusLabel } from '../../shared/labels.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import {
  HoursPipe,
  IsoDatePipe,
  PriorityLabelPipe,
  StatusClassPipe,
  StatusLabelPipe,
  CategoryLabelPipe,
} from '../../shared/pipes.js';
import { buildWorkflow } from '../../shared/workflow.js';
import { IdeaDetailComponent } from './idea-detail.component.js';
import { AgentWorkflowComponent } from '../../shared/agent-workflow.component.js';
import { ChangedFilesComponent } from '../../shared/changed-files.component.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { assertImageSizes } from '../../shared/image-upload.js';
import { FieldErrors, focusField } from '../../shared/field-errors.js';
import { errorMessage } from '../../core/errors.js';
import {
  IDEA_EDITABLE_STATUSES,
  IDEA_SELECTABLE_STATUSES,
  IDEA_STATUSES,
  ideaDisplayStatus,
  ideaPhase,
  isOpenIdea,
  VISIONARY_CONFIRM,
  SOURCE_FILTER_OPTIONS,
  sourceLabel,
} from './idea-options.js';

const VISIONARY_POLL_MS = 3000;
const OPEN_RUN = new Set(['requested', 'running']);

const DEFAULT_STATUS_FILTER = ['idea', 'considering', 'review', 'requested'].map(statusLabel);
const PRIORITY_RANK = ['low', 'medium', 'high'];

@Component({
  selector: 'app-ideation',
  standalone: true,
  imports: [
    GithubLinkComponent,
    NgClass,
    NgTemplateOutlet,
    FormsModule,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    DataActionsDirective,
    GalleryComponent,
    GitTreeComponent,
    IdeaDetailComponent,
    AgentWorkflowComponent,
    OrderBriefComponent,
    ChangedFilesComponent,
    MarkdownPipe,
    HoursPipe,
    IsoDatePipe,
    PriorityLabelPipe,
    StatusClassPipe,
    StatusLabelPipe,
    CategoryLabelPipe,
  ],
  templateUrl: './ideation.component.html',
  host: { style: 'display: contents' },
})
export class IdeationComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmService);
  protected readonly defaultStatusFilter = DEFAULT_STATUS_FILTER;
  private readonly defaultFilters = { status: DEFAULT_STATUS_FILTER };
  /** Dashboard-Link mit Filter hat Vorrang vor dem Standardfilter. */
  protected readonly ideaFilters = computed(() => {
    const linked = this.store.filtersFor('ideation');
    return Object.keys(linked).length ? linked : this.defaultFilters;
  });
  protected readonly ideaId = (idea: Idea): string => idea.id;
  protected readonly ideaColumns: DataColumn<Idea>[] = [
    { id: 'title', header: 'Titel', value: (idea) => idea.title, filter: 'text', className: 'title-cell' },
    {
      id: 'status',
      header: 'Status',
      value: (idea) => statusLabel(idea.status),
      sortValue: (idea) => IDEA_STATUSES.indexOf(idea.status),
    },
    categoryColumn<Idea>((idea) => idea.category),
    { id: 'source', header: 'Herkunft', value: (idea) => sourceLabel(idea.source), options: SOURCE_FILTER_OPTIONS },
    {
      id: 'priority',
      header: 'Priorität',
      value: (idea) => priorityLabel(idea.priority),
      sortValue: (idea) => PRIORITY_RANK.indexOf(idea.priority),
    },
    {
      id: 'effortHours',
      header: 'Aufwand',
      value: (idea) => formatHours(idea.effortHours),
      sortValue: (idea) => idea.effortHours ?? -1,
    },
    {
      id: 'createdAt',
      header: 'Erstellt',
      value: (idea) => formatIsoDate(idea.createdAt),
      sortValue: (idea) => idea.createdAt,
    },
  ];
  /** In Bearbeitung und Abgeschlossen: Status aus Idee und Auftrag abgeleitet. */
  protected readonly groupColumns: DataColumn<Idea>[] = [
    this.ideaColumns.find((column) => column.id === 'title')!,
    {
      id: 'status',
      header: 'Status',
      value: (idea) => statusLabel(this.ideaStatus(idea)),
      sortValue: (idea) => IDEA_STATUSES.indexOf(this.ideaStatus(idea)),
    },
    this.ideaColumns.find((column) => column.id === 'category')!,
    this.ideaColumns.find((column) => column.id === 'createdAt')!,
  ];
  protected readonly categories = CATEGORIES;
  /** Badge-Text wie Spalte und Filter „Herkunft“. */
  protected readonly sourceLabel = sourceLabel;

  protected readonly ideaErrors = new FieldErrors();
  protected ideaForm: { title: string; description: string; priority: Priority; category: string } = {
    title: '',
    description: '',
    priority: 'medium',
    category: '',
  };
  protected pendingImages: File[] = [];
  protected readonly openIdea = signal<string | null>(null);
  protected readonly ideaEditing = signal(false);
  protected readonly expandedIdea = signal<string | null>(null);
  protected readonly showClosedIdeas = signal(false);
  protected readonly showInProgressIdeas = signal(true);
  /** Mehrfachauswahl offener Ideen: für alle gewählten auf einmal einen Auftrag ausformulieren lassen. */
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  /** Letzter Visionär-Lauf des Projekts; solange er angefragt ist oder läuft, wird der Fortschritt abgefragt. */
  protected readonly visionaryRun = signal<VisionaryRun | null>(null);
  protected readonly visionaryOpen = computed(() => OPEN_RUN.has(this.visionaryRun()?.status ?? ''));

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      untracked(() => {
        this.visionaryRun.set(null);
        if (slug) void this.loadVisionaryRun(slug);
      });
    });
    inject(DestroyRef).onDestroy(
      visibleInterval(() => {
        const slug = this.store.activeProject();
        if (slug && this.visionaryOpen()) void this.loadVisionaryRun(slug);
      }, VISIONARY_POLL_MS),
    );
  }

  private visionaryPath(slug = this.store.activeProject()): string {
    return `${this.api.projectPath(slug)}/ideation/visionary`;
  }

  private async loadVisionaryRun(slug: string): Promise<void> {
    const wasOpen = this.visionaryOpen();
    const result = await this.api.get<{ run: VisionaryRun | null }>(this.visionaryPath(slug)).catch(() => null);
    if (!result || slug !== this.store.activeProject()) return;
    this.visionaryRun.set(result.run);
    // Lauf eben fertig geworden: neue Ideen laden.
    if (wasOpen && !this.visionaryOpen()) await this.store.loadProject(slug, true);
  }

  /** Vor dem Start fragen, ob der Visionär eine Richtung bekommen soll; leer = ohne Vorgabe, Abbrechen = kein Lauf. */
  protected async startVisionary(): Promise<void> {
    const answer = await this.confirm.ask(VISIONARY_CONFIRM);
    if (!answer) return;
    await this.store.perform(
      async () => {
        const result = await this.api.post<{ run: VisionaryRun }>(this.visionaryPath(), {
          comment: answer.comment.trim(),
        });
        this.visionaryRun.set(result.run);
      },
      'Der Visionär sammelt Ideen – der Fortschritt erscheint hier.',
      false,
    );
  }

  protected async cancelVisionary(): Promise<void> {
    await this.store.perform(
      async () => {
        const result = await this.api.post<{ run: VisionaryRun }>(`${this.visionaryPath()}/cancel`);
        this.visionaryRun.set(result.run);
      },
      'Visionär-Lauf abgebrochen.',
      false,
    );
  }

  protected readonly promotable = computed(() => this.openIdeas().filter((idea) => this.canPromote(idea)));
  protected readonly pickedIdeas = computed(() => this.promotable().filter((idea) => this.picked().has(idea.id)));

  protected readonly inProgressIdeas = computed(() => this.data().ideas.filter((idea) => this.isInProgress(idea)));
  protected readonly closedIdeas = computed(() => this.data().ideas.filter((idea) => this.isClosedIdea(idea)));
  protected readonly selectedIdea = computed(
    () => this.data().ideas.find((idea) => idea.id === this.openIdea()) ?? null,
  );
  /** Offene Ideen: weder angenommen noch abgelehnt – Abgeschlossene stehen nur unten in ihrer Gruppe. */
  protected readonly openIdeas = computed(() => this.data().ideas.filter((idea) => isOpenIdea(idea)));

  protected gitNodes(idea: Idea, order: DevelopmentItem | null, sprint: Sprint | null): GitNode[] {
    return [
      { kind: 'step', label: 'Idee', text: idea.title },
      ...(order ? [{ kind: 'step', label: 'Auftrag', text: order.title } satisfies GitNode] : []),
      ...(sprint ? [branchNode(sprint), commitNode(sprint)] : []),
    ];
  }

  protected workflowOf(order: DevelopmentItem) {
    return buildWorkflow(this.data(), order);
  }

  protected ideaStatus(idea: Idea): string {
    return ideaDisplayStatus(idea, this.closedIdeaOrder(idea));
  }

  protected closedIdeaOrder(idea: Idea) {
    return this.data().development.find((item) => item.ideationId === idea.id) ?? null;
  }

  protected canPromote(idea: Idea): boolean {
    return IDEA_SELECTABLE_STATUSES.includes(idea.status) && !this.closedIdeaOrder(idea);
  }

  /** Für die Tabelle: welche Zeilen ein Häkchen bekommen und wie es vorgelesen wird. */
  protected readonly promotableRow = (idea: Idea): boolean => this.canPromote(idea);
  protected readonly pickLabel = (idea: Idea): string => `Für Auftrag auswählen: ${idea.title}`;

  protected clearPicks(): void {
    this.picked.set(new Set());
  }

  /** Je gewählter Idee ein Auftrag: Die Ideen gehen an den Auftragsautor, der sie nacheinander ausformuliert. */
  protected async promotePicked(): Promise<void> {
    const ideas = this.pickedIdeas();
    if (!ideas.length) return;
    const failed: string[] = [];
    await this.store.perform(
      async () => {
        for (const idea of ideas) {
          try {
            await this.api.post(`/api/ideation/${encodeURIComponent(idea.id)}/define`);
          } catch {
            failed.push(idea.title);
          }
        }
        if (failed.length === ideas.length) throw new Error('Keine der gewählten Ideen konnte angefordert werden.');
      },
      `${ideas.length - failed.length} von ${ideas.length} Ideen gehen an den Auftragsautor – je Idee ein Auftrag.${
        failed.length ? ` Nicht möglich: ${failed.join(', ')}.` : ''
      }`,
    );
    this.clearPicks();
  }

  /** Bearbeiten wie auf dem Server erlaubt (nicht während der Auftragsautor schreibt, nicht nach der Annahme). */
  protected editable(idea: Idea): boolean {
    return IDEA_EDITABLE_STATUSES.includes(idea.status);
  }

  protected editIdea(id: string): void {
    this.ideaEditing.set(true);
    this.openIdea.set(id);
  }

  protected closeIdea(): void {
    this.openIdea.set(null);
    this.ideaEditing.set(false);
  }

  protected pendingImageNames(): string {
    return this.pendingImages.map((file) => file.name).join(', ');
  }

  protected selectPendingImages(input: HTMLInputElement): void {
    this.pendingImages = [...this.pendingImages, ...Array.from(input.files ?? [])];
    input.value = '';
  }

  protected async createIdea(form: HTMLFormElement): Promise<void> {
    const { title, description, priority, category } = this.ideaForm;
    if (!this.ideaErrors.require('title', title, 'Bitte einen Titel angeben.')) {
      focusField(form, 'title');
      return;
    }
    const files = this.pendingImages;
    let uploadError = '';
    await this.store.perform(async () => {
      // Größe vorher prüfen: Ein zu großes Bild darf keine Idee ohne Bild anlegen.
      assertImageSizes(files);
      const created = await this.api
        .post<{ item: Idea }>(`${this.api.projectPath(this.store.activeProject())}/ideation`, {
          title,
          description,
          priority,
          category: category || null,
        })
        .catch((error: unknown) => {
          this.ideaErrors.take(error, form);
          throw error;
        });
      // Angelegt ist angelegt: Formular sofort leeren, damit ein zweiter Klick keine doppelte Idee erzeugt.
      this.pendingImages = [];
      this.ideaForm = { title: '', description: '', priority: 'medium', category: '' };
      this.store.showCreate.set(false);
      uploadError = await this.uploadImages(created.item.id, files).then(
        () => '',
        (error: unknown) => errorMessage(error, 'Upload fehlgeschlagen.'),
      );
    }, 'Idee wurde hinzugefügt.');
    if (uploadError) this.store.notice.set(`Idee wurde hinzugefügt, Bilder aber nicht: ${uploadError}`);
  }

  private isInProgress(idea: Idea): boolean {
    // Nur mit vorhandenem, noch nicht abgeschlossenen Auftrag gilt eine Idee als „in Bearbeitung“.
    return ideaPhase(idea, this.closedIdeaOrder(idea)) === 'in_progress';
  }

  private isClosedIdea(idea: Idea): boolean {
    const phase = ideaPhase(idea, this.closedIdeaOrder(idea));
    return phase === 'implemented' || phase === 'discarded';
  }

  private async uploadImages(ideationId: string, files: File[]): Promise<void> {
    assertImageSizes(files);
    for (const file of files) {
      await this.api.upload(`/api/ideation/${encodeURIComponent(ideationId)}/attachments`, file);
    }
  }
}
