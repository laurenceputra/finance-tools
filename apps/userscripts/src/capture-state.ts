export interface CaptureEvent {
  path: string;
  payload: unknown;
  capturedAt: string;
  route?: string;
  startedAt?: string;
  accountContext?: string;
}
/** Only a short startup window; no disk storage and explicit lock/navigation destroys the queue. */
export class EarlyCaptureQueue {
  private events: { event: CaptureEvent; expires: number; bytes: number }[] = [];
  private stopped = false;
  constructor(
    private now = () => Date.now(),
    private ttl = 30_000,
  ) {}
  push(event: CaptureEvent) {
    if (this.stopped) return;
    const bytes = JSON.stringify(event).length;
    if (bytes > 2_000_000) return;
    this.events = this.events.filter((x) => x.expires > this.now());
    while (
      this.events.length >= 6 ||
      this.events.reduce((n, x) => n + x.bytes, 0) + bytes > 4_000_000
    )
      this.events.shift();
    this.events.push({ event, expires: this.now() + this.ttl, bytes });
  }
  take() {
    const events = this.events.filter((x) => x.expires > this.now()).map((x) => x.event);
    this.clear();
    return events;
  }
  clear() {
    this.events = [];
    this.stopped = true;
  }
}
export class EndowusJoin {
  private components = new Map<string, CaptureEvent>();
  private expiry?: ReturnType<typeof setTimeout>;
  clear() {
    this.components.clear();
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
  }
  add(event: CaptureEvent) {
    if (
      !Number.isFinite(Date.parse(event.capturedAt)) ||
      !Number.isFinite(Date.parse(event.startedAt ?? event.capturedAt))
    ) {
      this.clear();
      return;
    }
    const field = (
      {
        '/v1/goals/performance': 'performance',
        '/v2/goals/investible': 'investible',
        '/v1/goals': 'goals',
      } as Record<string, string>
    )[event.path];
    if (!field) return;
    const existing = [...this.components.values()];
    if (!Array.isArray(event.payload)) {
      this.clear();
      return;
    }
    if (
      existing.some(
        (x) =>
          x.route !== event.route ||
          x.accountContext !== event.accountContext ||
          Math.abs(
            Date.parse(x.startedAt ?? x.capturedAt) -
              Date.parse(event.startedAt ?? event.capturedAt),
          ) > 15_000,
      )
    )
      this.clear();
    this.components.set(field, event);
    if (!this.expiry) this.expiry = setTimeout(() => this.clear(), 15_000);
    if (this.components.size !== 3) return;
    const components = [...this.components.values()],
      capturedAt = components.map((x) => x.capturedAt).sort()[0];
    const input = {
      performance: this.components.get('performance')!.payload,
      investible: this.components.get('investible')!.payload,
      goals: this.components.get('goals')!.payload,
    };
    const sets = components.map(
      (component) =>
        new Set(
          (component.payload as { goalId?: string }[])
            .map((row) => row?.goalId)
            .filter((id): id is string => typeof id === 'string'),
        ),
    );
    const incomplete = sets.some(
      (set) => set.size !== sets[0].size || [...set].some((id) => !sets[0].has(id)),
    );
    this.clear();
    return { input, capturedAt, incomplete };
  }
}
