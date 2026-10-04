/** Atomic memory merges. Dirty captures are never overwritten by a pull or silently evicted. */
export class CaptureStore<T extends { id: string }> {
  private entries = new Map<string, { value: T; dirty: boolean }>();
  constructor(private limit = 10000) {}
  get values() {
    return [...this.entries.values()].map((entry) => entry.value);
  }
  get dirty() {
    return [...this.entries.values()].filter((entry) => entry.dirty).map((entry) => entry.value);
  }
  add(values: readonly T[], dirty = true) {
    const next = new Map(this.entries);
    for (const value of values) {
      const previous = next.get(value.id);
      if (!dirty && previous?.dirty) continue;
      next.set(value.id, { value, dirty: dirty || previous?.dirty === true });
    }
    if (next.size > this.limit)
      throw new Error(
        `Local capture limit (${this.limit}) reached. Export/sync or explicitly discard data before capturing more; nothing was evicted.`,
      );
    this.entries = next;
  }
  synced(value: T) {
    const entry = this.entries.get(value.id);
    if (entry?.value === value) entry.dirty = false;
  }
  remove(id: string) {
    this.entries.delete(id);
  }
  retain(predicate: (value: T) => boolean) {
    for (const [id, entry] of this.entries)
      if (predicate(entry.value) === false) this.entries.delete(id);
  }
  clear() {
    this.entries.clear();
  }
}
