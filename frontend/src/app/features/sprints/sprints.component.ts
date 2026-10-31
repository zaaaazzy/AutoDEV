import { NgClass, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { SortingState } from '@tanstack/angular-table';
import type { Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { formatIsoDate } from '../../shared/format.js';
import { ciLabel, combinedCategory, statusLabel } from '../../shared/labels.js';
import { FieldErrors, focusField } from '../../shared/field-errors.js';
import { StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { SprintDetailComponent } from './sprint-detail.component.js';
import { SprintProposalComponent } from './sprint-proposal.component.js';

/** Welcher Sprint oben als „aktueller“ steht: der laufende, sonst der im Review, sonst der nächste geplante. */
const CURRENT_RANK = ['active', 'review', 'planned'];
const CLOSED_STATUSES: string[] = ['completed', 'cancelled'];

/**
 * Sprint-Seite wie die Auftragsseite: oben der aktuelle Sprint mit allen Aufträgen, darunter die geplanten
 * und die abgeschlossenen Sprints als Listen; jede Zeile klappt die Sprint-Details auf.
 */
@Component({
  selector: 'app-sprints',
  standalone: true,
  imports: [
    NgClass,
    NgTemplateOutlet,
    FormsModule,
    SprintDetailComponent,
    SprintProposalComponent,
    StatusClassPipe,
    StatusLabelPipe,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
  ],
  templateUrl: './sprints.component.html',
  host: { style: 'display: contents' },
})
export class SprintsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly sprintErrors = new FieldErrors();
  protected sprintForm = { name: '', goal: '', startDate: '', endDate: '' };

  protected readonly current = computed(() => {
    const candidates = this.data().sprints.filter((sprint) => CURRENT_RANK.includes(sprint.status));
    return (
      [...candidates].sort(
        (a, b) =>
          CURRENT_RANK.indexOf(a.status) - CURRENT_RANK.indexOf(b.status) ||
          (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999'),
      )[0] ?? null
    );
  });
  protected readonly upcoming = computed(() =>
    this.data().sprints.filter(
      (sprint) => !CLOSED_STATUSES.includes(sprint.status) && sprint.id !== this.current()?.id,
    ),
  );
  /** Abgeschlossene und abgebrochene Sprints: beide sind vorbei und stehen in derselben Liste. */
  protected readonly completed = computed(() =>
    this.data().sprints.filter((sprint) => CLOSED_STATUSES.includes(sprint.status)),
  );
  /** Über einen gefilterten Link geöffnet oder noch kein laufender Sprint: abgeschlossene gleich zeigen. */
  protected readonly showDone = signal(
    Object.values(this.store.filtersFor('sprints')).some((values) => values.length) || !this.current(),
  );
  protected readonly upcomingSort: SortingState = [{ id: 'start', desc: false }];
  protected readonly completedSort: SortingState = [{ id: 'end', desc: true }];
  protected readonly openSprint = signal<string | null>(null);
  protected readonly sprintId = (sprint: Sprint): string => sprint.id;
  protected readonly sprintColumns: DataColumn<Sprint>[] = [
    { id: 'name', header: 'Sprint', value: (sprint) => sprint.name, filter: 'text', className: 'title-cell' },
    {
      id: 'status',
      header: 'Status',
      value: (sprint) => statusLabel(sprint.status),
    },
    categoryColumn<Sprint>((sprint) =>
      combinedCategory(
        this.data()
          .development.filter((item) => item.sprintId === sprint.id)
          .map((item) => item.category),
      ),
    ),
    {
      id: 'start',
      header: 'Start',
      value: (sprint) => (sprint.startDate ? formatIsoDate(sprint.startDate) : ''),
      sortValue: (sprint) => sprint.startDate ?? '',
      filter: false,
    },
    {
      id: 'end',
      header: 'Ende',
      value: (sprint) => (sprint.endDate ? formatIsoDate(sprint.endDate) : ''),
      sortValue: (sprint) => sprint.endDate ?? '',
      filter: false,
    },
    {
      id: 'progress',
      header: 'Aufträge',
      value: (sprint) => `${this.sprintCounts(sprint.id).done}/${this.sprintCounts(sprint.id).total}`,
      sortValue: (sprint) => this.sprintCounts(sprint.id).done,
      filter: false,
    },
  ];

  protected sprintCounts(sprintId: string): { done: number; total: number } {
    const orders = this.data().development.filter((item) => item.sprintId === sprintId);
    return { done: orders.filter((item) => item.status === 'done').length, total: orders.length };
  }

  protected ciLabel(sprint: Sprint): string {
    return ciLabel(sprint.ciStatus);
  }

  protected toggleSprint(id: string): void {
    this.openSprint.update((current) => (current === id ? null : id));
  }

  protected async createSprint(form: HTMLFormElement): Promise<void> {
    if (!this.sprintErrors.require('name', this.sprintForm.name, 'Bitte einen Namen angeben.')) {
      focusField(form, 'name');
      return;
    }
    const body = {
      name: this.sprintForm.name,
      goal: this.sprintForm.goal,
      startDate: this.sprintForm.startDate || null,
      endDate: this.sprintForm.endDate || null,
    };
    await this.store.perform(async () => {
      await this.api
        .post(`${this.api.projectPath(this.store.activeProject())}/sprints`, body)
        .catch((error: unknown) => {
          this.sprintErrors.take(error, form);
          throw error;
        });
      this.sprintForm = { name: '', goal: '', startDate: '', endDate: '' };
      this.store.showCreate.set(false);
    }, 'Sprint angelegt.');
  }
}
