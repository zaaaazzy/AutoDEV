import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { ConfirmService } from '../core/confirm.service.js';

/** Eigener Bestätigungsdialog mit optionalem Kommentar; einmal in der App eingebunden, gesteuert vom ConfirmService. */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  template: `
    @if (confirm.pending(); as pending) {
      <div class="modal-backdrop confirm-backdrop" (click)="cancel()">
        <section
          class="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-message"
          (click)="$event.stopPropagation()"
          (keydown.escape)="cancel()"
        >
          <h2 id="confirm-title">{{ pending.options.title }}</h2>
          <p id="confirm-message" class="confirm-message">{{ pending.options.message }}</p>
          @if (pending.options.details?.length) {
            <ul class="confirm-details">
              @for (detail of pending.options.details; track $index) {
                <li>{{ detail }}</li>
              }
            </ul>
          }
          <form class="confirm-form" (submit)="$event.preventDefault(); accept()">
            <label for="confirm-comment">{{ pending.options.commentLabel ?? 'Kommentar (optional)' }}</label>
            <textarea
              #field
              id="confirm-comment"
              rows="3"
              maxlength="2000"
              [placeholder]="pending.options.commentPlaceholder ?? ''"
              [value]="comment()"
              (input)="comment.set($any($event.target).value)"
              (keydown.control.enter)="accept()"
              (keydown.meta.enter)="accept()"
            ></textarea>
            @if (pending.options.commentHint) {
              <small class="muted">{{ pending.options.commentHint }}</small>
            }
            <div class="confirm-actions">
              <button class="button secondary" type="button" (click)="cancel()">Abbrechen</button>
              <button class="button primary" type="submit">{{ pending.options.confirmLabel }}</button>
            </div>
          </form>
        </section>
      </div>
    }
  `,
})
export class ConfirmDialogComponent {
  protected readonly confirm = inject(ConfirmService);
  protected readonly comment = signal('');
  private readonly field = viewChild<ElementRef<HTMLTextAreaElement>>('field');

  constructor() {
    // Neuer Dialog: Feld leeren und fokussieren.
    effect(() => {
      if (!this.confirm.pending()) return;
      this.comment.set('');
      queueMicrotask(() => this.field()?.nativeElement.focus());
    });
  }

  protected accept(): void {
    this.confirm.settle({ comment: this.comment().trim() });
  }

  protected cancel(): void {
    this.confirm.settle(null);
  }
}
