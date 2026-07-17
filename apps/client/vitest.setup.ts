// Node 22+ defines experimental webstorage globals (localStorage/sessionStorage)
// that resolve to undefined unless node is launched with --localstorage-file.
// Inside vitest's jsdom environment they shadow jsdom's implementations, so
// window.localStorage comes out undefined on newer local Node versions while
// CI's Node 20 (no such globals) gets jsdom's real one. Install an in-memory
// Storage when the global is missing so tests behave the same everywhere.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (!globalThis[name]) {
    Object.defineProperty(globalThis, name, {
      value: new MemoryStorage(),
      writable: true,
      configurable: true,
    });
  }
}
