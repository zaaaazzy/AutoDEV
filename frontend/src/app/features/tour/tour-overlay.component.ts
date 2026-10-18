import { Component, computed, effect, inject, OnDestroy, signal } from '@angular/core';
import { TourService } from './tour.service.js';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PADDING = 8;

/**
 * Spotlight der Tour: alles abgedunkelt bis auf das Ziel, das anklickbar bleibt. Die Karte erklärt den Schritt und
 * steht neben dem Ziel (auf dem Handy unten).
 */
@Component({
  selector: 'app-tour-overlay',
  standalone: true,
  templateUrl: './tour-overlay.component.html',
})
export class TourOverlayComponent implements OnDestroy {
  protected readonly tour = inject(TourService);
  protected readonly box = signal<Box | null>(null);
  protected readonly waiting = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;
  private clickTarget: Element | null = null;
  private readonly onTargetClick = (): void => {
    if (this.tour.step()?.waitFor === 'click') globalThis.setTimeout(() => this.tour.next(), 150);
  };

  /** Abdeckungen rund um das Ziel; dazwischen bleibt das Ziel bedienbar. */
  protected readonly shades = computed(() => {
    const box = this.box();
    if (!box) return [{ top: 0, left: 0, width: innerWidth, height: innerHeight }];
    const right = box.left + box.width;
    const bottom = box.top + box.height;
    return [
      { top: 0, left: 0, width: innerWidth, height: Math.max(0, box.top) },
      { top: bottom, left: 0, width: innerWidth, height: Math.max(0, innerHeight - bottom) },
      { top: box.top, left: 0, width: Math.max(0, box.left), height: box.height },
      { top: box.top, left: right, width: Math.max(0, innerWidth - right), height: box.height },
    ];
  });

  /** Karte rechts/unterhalb des Ziels, sonst darüber; auf schmalen Bildschirmen unten fixiert. */
  protected readonly cardStyle = computed(() => {
    const box = this.box();
    if (innerWidth <= 720 || !box) return null;
    const width = 340;
    const below = box.top + box.height + 14;
    const top = below + 220 < innerHeight ? below : Math.max(12, box.top - 234);
    const left = Math.min(Math.max(12, box.left), innerWidth - width - 12);
    return { top: `${top}px`, left: `${left}px`, width: `${width}px` };
  });

  constructor() {
    effect(() => {
      const step = this.tour.step();
      this.detach();
      if (!step) {
        this.stop();
        return;
      }
      this.waiting.set(Boolean(step.waitFor));
      this.start();
    });
  }

  ngOnDestroy(): void {
    this.stop();
    this.detach();
  }

  private start(): void {
    this.stop();
    let scrolled = false;
    const tick = (): void => {
      const step = this.tour.step();
      if (!step) return;
      if (typeof step.waitFor === 'function' && step.waitFor(this.tour)) {
        this.tour.next();
        return;
      }
      const element = this.find(step);
      if (!element) {
        this.box.set(null);
        return;
      }
      if (!scrolled) {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        scrolled = true;
      }
      if (step.waitFor === 'click' && this.clickTarget !== element) {
        this.detach();
        element.addEventListener('click', this.onTargetClick, { capture: true });
        this.clickTarget = element;
      }
      const rect = element.getBoundingClientRect();
      const size = step.shape === 'circle' ? Math.max(rect.width, rect.height) + PADDING * 2 : 0;
      this.box.set(
        step.shape === 'circle'
          ? {
              top: rect.top + rect.height / 2 - size / 2,
              left: rect.left + rect.width / 2 - size / 2,
              width: size,
              height: size,
            }
          : {
              top: rect.top - PADDING,
              left: rect.left - PADDING,
              width: rect.width + PADDING * 2,
              height: rect.height + PADDING * 2,
            },
      );
    };
    tick();
    this.timer = setInterval(tick, 250);
  }

  private find(step: { target?: string; targets?: string[] }): Element | null {
    for (const selector of [...(step.targets ?? []), ...(step.target ? [step.target] : [])]) {
      const element = Array.from(document.querySelectorAll(selector)).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (element) return element;
    }
    return null;
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private detach(): void {
    this.clickTarget?.removeEventListener('click', this.onTargetClick, { capture: true });
    this.clickTarget = null;
  }

  protected async runAction(): Promise<void> {
    await this.tour.step()?.action?.run(this.tour);
  }
}
