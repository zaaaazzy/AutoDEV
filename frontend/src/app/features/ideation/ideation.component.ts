import { OrderBriefComponent } from '../../shared/order-brief.component.js';
import { NgClass, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { DevelopmentItem, Idea, Priority, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
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
import { CATEGORIES, priorityLabel, statusLabel, isFinished } from '../../shared/labels.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import {
  HoursPipe,
  PriorityLabelPipe,
  ShortTextPipe,
  StatusClassPipe,
  StatusLabelPipe,
  CategoryLabelPipe,
} from '../../shared/pipes.js';
import { buildWorkflow } from '../../shared/workflow.js';
import { IdeaDetailComponent } from './idea-detail.component.js';
import { AgentWorkflowComponent } from '../../shared/agent-workflow.component.js';
import { ChangedFilesComponent } from '../../shared/changed-files.component.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { IDEA_STATUSES, ideaDisplayStatus, MAX_IMAGE_BYTES } from './idea-options.js';

const DEFAULT_STATUS_FILTER = ['idea', 'considering', 'review', 'requested'].map(statusLabel);
const PRIORITY_RANK = ['low', 'medium', 'high'];

@Component({
  selector: 'app-ideation',
  standalone: true,
  imports: [
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
    PriorityLabelPipe,
    ShortTextPipe,
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

  protected readonly inProgressIdeas = computed(() => this.data().ideas.filter((idea) => this.isInProgress(idea)));
  protected readonly closedIdeas = computed(() => this.data().ideas.filter((idea) => this.isClosedIdea(idea)));
  protected readonly selectedIdea = computed(
    () => this.data().ideas.find((idea) => idea.id === this.openIdea()) ?? null,
  );
  protected readonly openIdeas = computed(() =>
    this.data().ideas.filter((idea) => !this.isClosedIdea(idea) && !this.isInProgress(idea)),
  );

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

  protected async createIdea(): Promise<void> {
    const { title, description, priority, category } = this.ideaForm;
    const files = this.pendingImages;
    await this.store.perform(async () => {
      const created = await this.api.post<{ item: Idea }>(
        `${this.api.projectPath(this.store.activeProject())}/ideation`,
        {
          title,
          description,
          priority,
          category: category || null,
        },
      );
      this.pendingImages = [];
      await this.uploadImages(created.item.id, files);
      this.ideaForm = { title: '', description: '', priority: 'medium', category: '' };
      this.store.showCreate.set(false);
    }, 'Idee wurde hinzugefügt.');
  }

  private isInProgress(idea: Idea): boolean {
    // Nur mit vorhandenem, noch nicht abgeschlossenen Auftrag gilt eine Idee als „in Bearbeitung“.
    const order = this.closedIdeaOrder(idea);
    return idea.status === 'accepted' && !!order && !isFinished(order.status);
  }

  private isClosedIdea(idea: Idea): boolean {
    return idea.status === 'rejected' || (idea.status === 'accepted' && !this.isInProgress(idea));
  }

  private async uploadImages(ideationId: string, files: File[]): Promise<void> {
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} ist größer als 5 MB.`);
      await this.api.upload(`/api/ideation/${encodeURIComponent(ideationId)}/attachments`, file);
    }
  }
}
