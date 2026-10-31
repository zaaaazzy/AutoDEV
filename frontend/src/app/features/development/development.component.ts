import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { FocusOnce } from '../../core/focus-once.js';
import type { Priority } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { CATEGORIES, isFinished, statusLabel } from '../../shared/labels.js';
import { CategoryLabelPipe } from '../../shared/pipes.js';
import { FieldErrors, focusField } from '../../shared/field-errors.js';
import { OrderTableComponent } from './order-table.component.js';

@Component({
  selector: 'app-development',
  standalone: true,
  imports: [OrderTableComponent, FormsModule, CategoryLabelPipe],
  templateUrl: './development.component.html',
  host: { style: 'display: contents' },
})
export class DevelopmentComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;

  /** Laufzeit eines Entwurfs, z. B. „2 min“. */
  protected elapsed(startedAt: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
    return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  }

  protected readonly developmentErrors = new FieldErrors();
  protected developmentForm: { title: string; priority: Priority; category: string } = {
    title: '',
    priority: 'medium',
    category: '',
  };
  protected readonly categories = CATEGORIES;
  /** Über einen Dashboard-Link auf „Erledigt“ gefiltert: erledigte Aufträge gleich aufklappen. */
  protected readonly showDoneOrders = signal(
    (this.store.filtersFor('development')['status'] ?? []).includes(statusLabel('done')),
  );

  constructor() {
    // „+ Neuer Auftrag“: Das Formular steht unter den Entwürfen – hinscrollen und Titel fokussieren.
    effect(() => {
      if (!this.store.showCreate()) return;
      globalThis.setTimeout(() => {
        const form = document.querySelector<HTMLFormElement>('form.dev-create');
        form?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        form?.querySelector<HTMLInputElement>('input[name="title"]')?.focus({ preventScroll: true });
      });
    });
    // Aus einem Link (#development/<id>, z. B. im Sprintbericht): Auftrag aufklappen und hinscrollen.
    // Wartet der Auftrag auf dich, steht er unter „Aktionen“ – dorthin weiterleiten (Parameter wie ?answer=1 bleiben).
    // Hinscrollen nur einmal je Link, nicht bei jedem Nachladen im Hintergrund.
    const focus = new FocusOnce();
    effect(() => {
      const id = this.store.focusId();
      const inAttention = id ? this.store.attentionIds().has(id) : false;
      const present = !!id && this.data().development.some((item) => item.id === id);
      if (id && present && inAttention) {
        untracked(() => {
          const query = globalThis.location.hash.split('?')[1];
          this.store.navigate('actions', { focus: id });
          if (query) globalThis.history.replaceState(null, '', `#actions/${id}?${query}`);
        });
        return;
      }
      if (!focus.take(id, present)) return;
      untracked(() => {
        if (this.data().development.find((item) => item.id === id)?.status === 'done') this.showDoneOrders.set(true);
        globalThis.setTimeout(() => {
          const target = document.getElementById(`order-${id}`) ?? document.querySelector('.row-open');
          target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }, 200);
      });
    });
  }
  protected readonly doneOrders = computed(() =>
    this.data().development.filter((item) => item.status === 'done' && !this.store.attentionIds().has(item.id)),
  );
  protected readonly openOrders = computed(() =>
    this.data().development.filter((item) => !isFinished(item.status) && !this.store.attentionIds().has(item.id)),
  );

  protected async createDevelopment(form: HTMLFormElement): Promise<void> {
    if (!this.developmentErrors.require('title', this.developmentForm.title, 'Bitte einen Titel angeben.')) {
      focusField(form, 'title');
      return;
    }
    await this.store.perform(async () => {
      await this.api
        .post(`${this.api.projectPath(this.store.activeProject())}/development`, {
          ...this.developmentForm,
          category: this.developmentForm.category || null,
        })
        .catch((error: unknown) => {
          this.developmentErrors.take(error, form);
          throw error;
        });
      this.developmentForm = { title: '', priority: 'medium', category: '' };
      this.store.showCreate.set(false);
    }, 'Entwicklungsauftrag hinzugefügt.');
  }
}
