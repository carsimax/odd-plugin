export function createNotes(store) {
  return {
    create({ title, body = "", tags = [] }) {
      const id = (store.get("meta:counter") ?? 0) + 1;
      store.set("meta:counter", id);
      const note = { id, title, body, tags: [...tags] };
      store.set(`note:${id}`, note);
      return note;
    },

    get(id) {
      return store.get(`note:${id}`) ?? null;
    },

    list() {
      return store
        .keys("note:")
        .map((key) => store.get(key))
        .sort((a, b) => a.id - b.id);
    },

    remove(id) {
      return store.delete(`note:${id}`);
    },

    addTag(id, tag) {
      const note = store.get(`note:${id}`);
      if (!note) return null;
      if (!note.tags.includes(tag)) note.tags.push(tag);
      store.set(`note:${id}`, note);
      return note;
    },
  };
}
