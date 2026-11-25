export function createStats(store) {
  return {
    async summary() {
      const keys = await store.keys("note:");
      const notes = await Promise.all(keys.map((key) => store.get(key)));
      const tags = new Set(notes.flatMap((note) => note.tags));
      const words = notes.reduce((sum, note) => sum + `${note.title} ${note.body}`.split(/\s+/).filter(Boolean).length, 0);
      return { notes: notes.length, tags: tags.size, words };
    },
  };
}
