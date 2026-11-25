// In-memory Store with the async interface of the remote backend.
// Values are copied on the way in and out so callers cannot mutate stored data.
export class MemoryStore {
  #data = new Map();

  async get(key) {
    return this.#data.has(key) ? structuredClone(this.#data.get(key)) : undefined;
  }

  async set(key, value) {
    this.#data.set(key, structuredClone(value));
  }

  async has(key) {
    return this.#data.has(key);
  }

  async delete(key) {
    return this.#data.delete(key);
  }

  async keys(prefix = "") {
    return [...this.#data.keys()].filter((key) => key.startsWith(prefix));
  }
}
