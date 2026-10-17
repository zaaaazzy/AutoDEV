import { NgClass, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { DevelopmentItem, Idea, Priority, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ColumnHeaderComponent } from '../../shared/column-header.component.js';
import { branchNode, commitNode, type GitNode, GitTreeComponent } from '../../shared/git-tree.component.js';
import { formatHours, formatIsoDate } from '../../shared/format.js';
import { priorityLabel, statusLabel } from '../../shared/labels.js';
import { HoursPipe, PriorityLabelPipe, ShortTextPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { compareRanks, includesText, toggleListValue, toggleSort, type SortState } from '../../shared/table.js';
import { buildWorkflow } from '../../shared/workflow.js';
import { IdeaDetailComponent } from './idea-detail.component.js';
import { AgentWorkflowComponent } from '../../shared/agent-workflow.component.js';
import { ChangedFilesComponent } from '../../shared/changed-files.component.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { IDEA_STATUSES, ideaDisplayStatus, MAX_IMAGE_BYTES } from './idea-options.js';

const DEFAULT_STATUS_FILTER = ['idea', 'considering', 'review', 'requested'].map(statusLabel);

type IdeaKey = 'title' | 'description' | 'status' | 'priority' | 'effortHours' | 'createdAt';
type IdeaTextKey = 'title' | 'description';
type IdeaValueKey = 'status' | 'priority' | 'effortHours' | 'createdAt';

@Component({
  selector: 'app-ideation',
  standalone: true,
  imports: [
    NgClass,
    NgTemplateOutlet,
    FormsModule,
    ColumnHeaderComponent,
    GitTreeComponent,
    IdeaDetailComponent,
    AgentWorkflowComponent,
    ChangedFilesComponent,
    MarkdownPipe,
    HoursPipe,
    PriorityLabelPipe,
    ShortTextPipe,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './ideation.component.html',
  host: { style: 'display: contents' },
})
export class IdeationComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly ideaColumns: { key: IdeaKey; label: string }[] = [
    { key: 'title', label: 'Titel' },
    { key: 'status', label: 'Status' },
    { key: 'priority', label: 'Priorität' },
    { key: 'effortHours', label: 'Aufwand' },
    { key: 'createdAt', label: 'Erstellt' },
  ];

  protected ideaForm: { title: string; description: string; priority: Priority } = {
    title: '',
    description: '',
    priority: 'medium',
  };
  protected pendingImages: File[] = [];
  protected readonly openIdea = signal<string | null>(null);
  protected readonly ideaEditing = signal(false);
  protected readonly ideaTextFilter = signal<Partial<Record<IdeaTextKey, string>>>({});
  protected readonly ideaValueFilter = signal<Partial<Record<IdeaValueKey, string[]>>>({
    status: [...DEFAULT_STATUS_FILTER],
  });
  protected readonly ideaSort = signal<SortState<IdeaKey>>({ key: 'createdAt', dir: 'desc' });
  protected readonly showClosedIdeas = signal(false);
  protected readonly showInProgressIdeas = signal(true);
  protected readonly openClosedIdea = signal<string | null>(null);

  protected readonly inProgressIdeas = computed(() => this.data().ideas.filter((idea) => this.isInProgress(idea)));
  protected readonly closedIdeas = computed(() => this.data().ideas.filter((idea) => this.isClosedIdea(idea)));
  protected readonly selectedIdea = computed(
    () => this.data().ideas.find((idea) => idea.id === this.openIdea()) ?? null,
  );
  protected readonly sortedIdeas = computed(() => {
    const text = this.ideaTextFilter();
    const values = this.ideaValueFilter();
    const { key, dir } = this.ideaSort();
    const rank = (idea: Idea): string | number | null => {
      switch (key) {
        case 'status':
          return IDEA_STATUSES.indexOf(idea.status);
        case 'priority':
          return ['low', 'medium', 'high'].indexOf(idea.priority);
        case 'effortHours':
          return idea.effortHours ?? null;
        default:
          return (idea[key] ?? '').toString().toLowerCase();
      }
    };
    return this.data()
      .ideas.filter((idea) => !this.isClosedIdea(idea) && !this.isInProgress(idea))
      .filter(
        (idea) =>
          (['title', 'description'] as const).every((field) => includesText(idea[field], text[field])) &&
          (Object.keys(values) as IdeaValueKey[]).every(
            (field) => !values[field]?.length || values[field]!.includes(this.ideaCellValue(idea, field)),
          ),
      )
      .sort((a, b) => compareRanks(rank(a), rank(b), dir));
  });

  protected ideaCellValue(idea: Idea, key: IdeaValueKey): string {
    switch (key) {
      case 'status':
        return statusLabel(idea.status);
      case 'priority':
        return priorityLabel(idea.priority);
      case 'effortHours':
        return formatHours(idea.effortHours);
      default:
        return formatIsoDate(idea.createdAt);
    }
  }

  protected ideaOptions(key: IdeaKey): string[] {
    if (this.isTextColumn(key)) return [];
    return [
      ...new Set(
        this.data()
          .ideas.filter((idea) => !this.isClosedIdea(idea) && !this.isInProgress(idea))
          .map((idea) => this.ideaCellValue(idea, key)),
      ),
    ].sort();
  }

  protected isTextColumn(key: IdeaKey): key is IdeaTextKey {
    return key === 'title' || key === 'description';
  }

  protected textValue(key: IdeaKey): string | undefined {
    return this.isTextColumn(key) ? this.ideaTextFilter()[key] : undefined;
  }

  protected selectedValues(key: IdeaKey): string[] | undefined {
    return this.isTextColumn(key) ? undefined : this.ideaValueFilter()[key];
  }

  protected ideaFilterActive(key: IdeaKey): boolean {
    return this.isTextColumn(key) ? !!this.ideaTextFilter()[key] : !!this.ideaValueFilter()[key]?.length;
  }

  protected hasIdeaFilters(): boolean {
    const text = Object.values(this.ideaTextFilter()).some(Boolean);
    const values = this.ideaValueFilter();
    const keys = (Object.keys(values) as IdeaValueKey[]).filter((key) => values[key]?.length);
    const sameAsDefault =
      keys.length === 1 &&
      keys[0] === 'status' &&
      values.status!.length === DEFAULT_STATUS_FILTER.length &&
      DEFAULT_STATUS_FILTER.every((label) => values.status!.includes(label));
    return text || (keys.length > 0 && !sameAsDefault);
  }

  protected clearIdeaFilters(): void {
    this.ideaTextFilter.set({});
    this.ideaValueFilter.set({ status: [...DEFAULT_STATUS_FILTER] });
  }

  protected setIdeaText(key: IdeaKey, value: string): void {
    if (!this.isTextColumn(key)) return;
    this.ideaTextFilter.update((filter) => ({ ...filter, [key]: value }));
  }

  protected toggleIdeaValue(key: IdeaKey, value: string, checked: boolean): void {
    if (this.isTextColumn(key)) return;
    this.ideaValueFilter.update((filter) => ({ ...filter, [key]: toggleListValue(filter[key], value, checked) }));
  }

  protected sortIdeasBy(key: IdeaKey): void {
    this.ideaSort.update((sort) => toggleSort(sort, key));
  }

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
    const { title, description, priority } = this.ideaForm;
    const files = this.pendingImages;
    await this.store.perform(async () => {
      const created = await this.api.post<{ item: Idea }>(
        `${this.api.projectPath(this.store.activeProject())}/ideation`,
        {
          title,
          description,
          priority,
        },
      );
      this.pendingImages = [];
      await this.uploadImages(created.item.id, files);
      this.ideaForm = { title: '', description: '', priority: 'medium' };
      this.store.showCreate.set(false);
    }, 'Idee wurde hinzugefügt.');
  }

  private isInProgress(idea: Idea): boolean {
    return idea.status === 'accepted' && this.closedIdeaOrder(idea)?.status !== 'done';
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
