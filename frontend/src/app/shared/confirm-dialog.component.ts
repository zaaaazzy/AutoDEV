import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
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
            @if (!pending.options.withoutComment) {
              <label for="confirm-comment">{{ pending.options.commentLabel ?? 'Kommentar (optional)' }}</label>
              <textarea
                #field
                id="confirm-comment"
                rows="3"
                maxlength="2000"
                [placeholder]="pending.options.commentPlaceholder ?? ''"
                [required]="!!pending.options.commentRequired"
                [value]="comment()"
                (input)="comment.set($any($event.target).value)"
                (keydown.control.enter)="accept()"
                (keydown.meta.enter)="accept()"
              ></textarea>
              @if (pending.options.commentHint) {
                <small class="muted">{{ pending.options.commentHint }}</small>
              }
            }
            <div class="confirm-actions">
              <button class="button secondary" type="button" (click)="cancel()">Abbrechen</button>
              <button
                #submit
                class="button primary"
                type="submit"
                [class.danger]="!!pending.options.danger"
                [disabled]="missingComment()"
              >
                {{ pending.options.confirmLabel }}
              </button>
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
  private readonly submit = viewChild<ElementRef<HTMLButtonElement>>('submit');

  constructor() {
    // Neuer Dialog: Feld vorbelegen (bzw. leeren) und fokussieren; ohne Feld den Bestätigen-Knopf.
    effect(() => {
      const pending = this.confirm.pending();
      if (!pending) return;
      this.comment.set(pending.options.withoutComment ? '' : (pending.options.initialComment ?? ''));
      queueMicrotask(() => (this.field() ?? this.submit())?.nativeElement.focus());
    });
  }

  /** Pflichtkommentar fehlt: Bestätigen ist gesperrt (auch per Strg/Cmd+Enter). */
  protected readonly missingComment = computed(
    () => !!this.confirm.pending()?.options.commentRequired && !this.comment().trim(),
  );

  protected accept(): void {
    if (this.missingComment()) return;
    this.confirm.settle({ comment: this.comment().trim() });
  }

  protected cancel(): void {
    this.confirm.settle(null);
  }
}
