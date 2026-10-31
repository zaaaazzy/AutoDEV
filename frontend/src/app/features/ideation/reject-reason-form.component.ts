import { type AfterViewInit, Component, type ElementRef, input, output, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAX_REJECTION_REASON } from './idea-options.js';

/**
 * Eingabe des Ablehnungsgrunds (Pflicht, max. 1000 Zeichen) – gleich im Ideen-Dialog, im Schnell-Ablehnen-Popover
 * und für die Massenablehnung. Escape bricht nur dieses Formular ab (nicht den Dialog dahinter) und speichert nichts.
 */
@Component({
  selector: 'app-reject-reason-form',
  standalone: true,
  imports: [FormsModule],
  template: `
    <form class="idea-reject" (ngSubmit)="submit()" (keydown.escape)="cancel($event)">
      <label
        >{{ label() }}
        <textarea #field name="reason" [(ngModel)]="reason" [attr.maxlength]="max" required></textarea>
      </label>
      <div class="actions">
        <button class="button secondary" type="button" (click)="cancelled.emit()">Abbrechen</button>
        <button class="button primary" type="submit" [disabled]="busy() || !reason.trim()">
          {{ submitLabel() }}
        </button>
      </div>
    </form>
  `,
  host: { style: 'display: contents' },
})
export class RejectReasonFormComponent implements AfterViewInit {
  readonly label = input('Ablehnungsgrund (der Visionär beachtet ihn beim nächsten Lauf)');
  readonly submitLabel = input('Ablehnen');
  readonly busy = input(false);
  /** Nur im Popover: Dort öffnet der Nutzer das Feld eigens zum Schreiben. */
  readonly autofocus = input(false);
  /** Getrimmter, nicht leerer Grund. */
  readonly submitted = output<string>();
  readonly cancelled = output<void>();

  protected readonly max = MAX_REJECTION_REASON;
  protected reason = '';
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  ngAfterViewInit(): void {
    if (this.autofocus()) this.field().nativeElement.focus();
  }

  protected submit(): void {
    const reason = this.reason.trim();
    if (reason && reason.length <= this.max && !this.busy()) this.submitted.emit(reason);
  }

  protected cancel(event: Event): void {
    event.stopPropagation();
    this.cancelled.emit();
  }
}
