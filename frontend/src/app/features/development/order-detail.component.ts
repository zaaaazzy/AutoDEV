import { AgentWorkflowComponent } from '../../shared/agent-workflow.component.js';
import { Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { DevelopmentItem } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { GalleryComponent } from '../../shared/gallery.component.js';
import { DEVELOPMENT_STATUSES } from '../../shared/labels.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { StatusLabelPipe } from '../../shared/pipes.js';
import { OrderService } from './order.service.js';

/** Aufgeklappte Detailansicht eines offenen Auftrags. */
@Component({
  selector: 'app-order-detail',
  standalone: true,
  imports: [AgentWorkflowComponent, FormsModule, GalleryComponent, MarkdownPipe, StatusLabelPipe],
  templateUrl: './order-detail.component.html',
  host: { style: 'display: contents' },
})
export class OrderDetailComponent {
  private readonly orders = inject(OrderService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly developmentStatuses = DEVELOPMENT_STATUSES;
  protected readonly manualAgent: Record<string, string> = {};

  readonly order = input.required<DevelopmentItem>();
  readonly editing = input(false);
  readonly editStarted = output<void>();
  readonly editCancelled = output<void>();
  readonly saved = output<FormValues>();

  protected update(id: string, values: Partial<DevelopmentItem>): Promise<void> {
    return this.orders.update(id, values);
  }

  protected retry(item: DevelopmentItem): Promise<void> {
    return this.orders.retry(item);
  }

  protected analyze(item: DevelopmentItem): Promise<void> {
    return this.orders.analyze(item);
  }

  protected async startWithAgent(item: DevelopmentItem): Promise<void> {
    const agentId = this.manualAgent[item.id] || item.agentId;
    if (!agentId) return;
    await this.orders.startWithAgent(item, agentId);
    delete this.manualAgent[item.id];
  }
}
