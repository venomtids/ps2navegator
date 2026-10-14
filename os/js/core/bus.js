/** SECTOR OS — core/bus.js : emissor de eventos síncrono, sem dependências. */
export function createBus() {
  const map = new Map();
  return {
    on(type, fn) {
      let set = map.get(type);
      if (!set) map.set(type, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    off(type, fn) { map.get(type)?.delete(fn); },
    emit(type, payload) {
      const set = map.get(type);
      if (!set) return 0;
      let n = 0;
      for (const fn of Array.from(set)) {
        try { fn(payload); n++; } catch (e) { console.error(`[bus:${type}]`, e); }
      }
      return n;
    },
    clear() { map.clear(); }
  };
}
