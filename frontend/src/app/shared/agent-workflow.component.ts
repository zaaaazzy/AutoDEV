import { Component, computed, inject, input } from '@angular/core';
import type { DevelopmentItem, DocumentEntry } from '../core/models.js';
import { ProjectStore } from '../core/project-store.js';
import { MarkdownPipe } from './markdown.pipe.js';
import { AgentTableComponent, type AgentTableRow } from './agent-table.component.js';
import { StepResultComponent } from './step-result.component.js';
import { buildWorkflow, type WorkflowRow } from './workflow.js';

const MANUAL_TITLES: Record<string, string> = {
  manual_writer: 'Anwendungshandbuch',
  user_manual_writer: 'Benutzerhandbuch',
};

interface WorkflowTableRow extends AgentTableRow {
  workflow: WorkflowRow;
}

interface Attachment {
  label: string;
  content: string;
}

/** Agents eines Auftrags in Laufreihenfolge; jeder Agent klappt Ergebnis, Verlauf und Ausgabe auf. */
@Component({
  selector: 'app-agent-workflow',
  standalone: true,
  imports: [AgentTableComponent, MarkdownPipe, StepResultComponent],
  templateUrl: './agent-workflow.component.html',
})
export class AgentWorkflowComponent {
  private readonly store = inject(ProjectStore);
  readonly order = input.required<DevelopmentItem>();
  protected readonly tableRows = computed<WorkflowTableRow[]>(() =>
    buildWorkflow(this.store.data(), this.order()).map((row) => ({
      key: row.key,
      name: row.name,
      command: row.command,
      status: row.step?.status ?? 'waiting',
      hint: this.attachment(row)?.label ?? null,
      workflow: row,
    })),
  );

  /** Was der Agent hinterlassen hat: Auftragsdoku, Handbuch oder Testergebnis. */
  protected attachment(row: WorkflowRow): Attachment | null {
    const docs: DocumentEntry[] = this.store.data().docs;
    if (row.role === 'documenter') {
      const doc = docs.find((entry) => entry.kind === 'order' && entry.developmentId === this.order().id);
      return doc?.content.trim() ? { label: 'Dokumentation', content: doc.content } : null;
    }
    const manualTitle = row.role ? MANUAL_TITLES[row.role] : undefined;
    if (manualTitle) {
      const doc = docs.find((entry) => entry.kind === 'manual' && entry.title === manualTitle);
      return doc?.content.trim() ? { label: manualTitle, content: doc.content } : null;
    }
    if (row.role === 'tester' && row.step?.output.trim() && row.step.status !== 'running') {
      return { label: 'Testergebnis', content: row.step.output };
    }
    return null;
  }
}
