export function createNotes(store) {
  return {
    async create({ title, body = "", tags = [] }) {
      const id = ((await store.get("meta:counter")) ?? 0) + 1;
      await store.set("meta:counter", id);
      const note = { id, title, body, tags: [...tags] };
      await store.set(`note:${id}`, note);
      return note;
    },

    async get(id) {
      return (await store.get(`note:${id}`)) ?? null;
    },

    async list() {
      const keys = await store.keys("note:");
      const notes = await Promise.all(keys.map((key) => store.get(key)));
      return notes.sort((a, b) => a.id - b.id);
    },

    async remove(id) {
      return store.delete(`note:${id}`);
    },

    async addTag(id, tag) {
      const note = await store.get(`note:${id}`);
      if (!note) return null;
      if (!note.tags.includes(tag)) note.tags.push(tag);
      await store.set(`note:${id}`, note);
      return note;
    },
  };
}
