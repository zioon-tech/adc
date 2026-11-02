/** Notifications are hints; durable reads remain authoritative across replicas. */
export class TaskWaitHub {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly shutdown = new AbortController();

  notify(dispatchId: string): void {
    for (const listener of this.listeners.get(dispatchId) ?? []) listener();
  }

  close(): void {
    this.shutdown.abort();
    this.listeners.clear();
  }

  async wait<T>(
    dispatchId: string,
    read: () => Promise<T>,
    pending: (value: T) => boolean,
    waitMs: number,
    signal?: AbortSignal,
    fallbackMs = 1000
  ): Promise<T> {
    const lifecycle = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const deadline = performance.now() + waitMs;
    let changed = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      changed = true;
      wake?.();
    };
    const listeners = this.listeners.get(dispatchId) ?? new Set();
    listeners.add(notify);
    this.listeners.set(dispatchId, listeners);
    lifecycle.addEventListener("abort", notify);
    try {
      for (;;) {
        changed = false;
        const value = await read();
        const remaining = deadline - performance.now();
        if (!pending(value) || remaining <= 0 || lifecycle.aborted) return value;
        if (changed) continue;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, Math.min(fallbackMs, remaining));
          function finish() {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          }
          wake = finish;
          if (changed || lifecycle.aborted) finish();
        });
      }
    } finally {
      lifecycle.removeEventListener("abort", notify);
      listeners.delete(notify);
      if (!listeners.size) this.listeners.delete(dispatchId);
    }
  }
}
