// In-memory Store. Values are copied on the way in and out so callers cannot mutate stored data.
export class MemoryStore {
  #data = new Map();

  get(key) {
    return this.#data.has(key) ? structuredClone(this.#data.get(key)) : undefined;
  }

  set(key, value) {
    this.#data.set(key, structuredClone(value));
  }

  has(key) {
    return this.#data.has(key);
  }

  delete(key) {
    return this.#data.delete(key);
  }

  keys(prefix = "") {
    return [...this.#data.keys()].filter((key) => key.startsWith(prefix));
  }
}
