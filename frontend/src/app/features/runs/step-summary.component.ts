import { NgClass } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import type { RunStep } from '../../core/models.js';
import { AgentOutputPipe } from '../../shared/agent-output.pipe.js';
import { DurationPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { summarizeOutput } from './output-summary.js';

/** Ein Prüfschritt (Lint, Typen, Build, Tests …): Kurzfazit, Kennzahlen, Tabelle, Meldungen, Rohausgabe aufklappbar. */
@Component({
  selector: 'app-step-summary',
  standalone: true,
  imports: [NgClass, AgentOutputPipe, DurationPipe, StatusClassPipe, StatusLabelPipe],
  host: { class: 'step-summary' },
  template: `
    @let s = summary();
    <details class="step-card" [open]="open()">
      <summary>
        <span class="status" [ngClass]="step().status | statusClass">{{ step().status | statusLabel }}</span>
        @if (label()) {
          <span class="tag">{{ label() }}</span>
        }
        <strong class="step-command">{{ step().command }}</strong>
        <span class="muted">{{ step().durationMs | duration }}</span>
        <span class="step-headline">{{ s.headline }}</span>
      </summary>
      @if (s.facts.length) {
        <dl class="step-facts">
          @for (fact of s.facts; track fact.label) {
            <div>
              <dt>{{ fact.label }}</dt>
              <dd>{{ fact.value }}</dd>
            </div>
          }
        </dl>
      }
      @if (s.table; as table) {
        <div class="table-wrap step-table">
          <table>
            <caption>
              {{
                table.title
              }}
            </caption>
            <thead>
              <tr>
                @for (header of table.headers; track $index) {
                  <th>{{ header }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (row of table.rows; track $index) {
                <tr [class.step-total]="isTotal(row)">
                  @for (cell of row; track $index) {
                    <td>{{ cell }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      @if (s.issues.length) {
        <ul class="step-issues">
          @for (issue of s.issues; track $index) {
            <li [class]="'issue-' + issue.level">
              <span class="issue-level">{{ issue.level === 'error' ? 'Fehler' : 'Warnung' }}</span>
              @if (issue.code) {
                <code>{{ issue.code }}</code>
              }
              <span class="issue-message">{{ issue.message }}</span>
              @if (issue.location) {
                <code class="issue-location">{{ issue.location }}</code>
              }
              @if (issue.count > 1) {
                <span class="tag">{{ issue.count }}×</span>
              }
            </li>
          }
        </ul>
      }
      <details class="step-raw">
        <summary>Rohausgabe</summary>
        <article class="step-output" [innerHTML]="step().output | agentOutput"></article>
      </details>
    </details>
  `,
})
export class StepSummaryComponent {
  readonly step = input.required<RunStep>();
  readonly label = input('');
  readonly open = input(false);
  protected isTotal(row: string[]): boolean {
    return /total/i.test(row[1] ?? '');
  }

  protected readonly summary = computed(() =>
    summarizeOutput(this.step().command, this.step().output ?? '', this.step().status),
  );
}
