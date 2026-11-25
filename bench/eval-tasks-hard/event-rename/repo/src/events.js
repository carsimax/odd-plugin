export class EventBus {
  #handlers = new Map();

  // Subscribes to an event name, or to every event of an entity with "entity.*". Returns an unsubscribe function.
  on(name, handler) {
    const list = this.#handlers.get(name) ?? [];
    list.push(handler);
    this.#handlers.set(name, list);
    return () => this.#handlers.set(name, (this.#handlers.get(name) ?? []).filter((h) => h !== handler));
  }

  // Calls the matching handlers with (payload, name). Returns how many handlers ran.
  emit(name, payload) {
    const entity = name.split(".")[0];
    const matching = [...(this.#handlers.get(name) ?? []), ...(this.#handlers.get(`${entity}.*`) ?? [])];
    for (const handler of matching) handler(payload, name);
    return matching.length;
  }
}
