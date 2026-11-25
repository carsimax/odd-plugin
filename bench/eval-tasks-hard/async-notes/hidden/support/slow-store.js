// A Store whose every method is truly asynchronous, like a remote backend.
const later = (fn) => new Promise((resolve, reject) => setImmediate(() => { try { resolve(fn()); } catch (e) { reject(e); } }));

export class SlowStore {
  #data = new Map();
  get(key) { return later(() => (this.#data.has(key) ? structuredClone(this.#data.get(key)) : undefined)); }
  set(key, value) { return later(() => { this.#data.set(key, structuredClone(value)); }); }
  has(key) { return later(() => this.#data.has(key)); }
  delete(key) { return later(() => this.#data.delete(key)); }
  keys(prefix = "") { return later(() => [...this.#data.keys()].filter((k) => k.startsWith(prefix))); }
}
