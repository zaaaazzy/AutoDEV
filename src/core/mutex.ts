/** Serialises async sections; waiters are served in arrival order. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Resolves with a release function once all earlier holders released. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return ready;
  }
}
