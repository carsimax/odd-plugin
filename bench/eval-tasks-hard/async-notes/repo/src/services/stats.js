export function createStats(store) {
  return {
    summary() {
      const notes = store.keys("note:").map((key) => store.get(key));
      const tags = new Set(notes.flatMap((note) => note.tags));
      const words = notes.reduce((sum, note) => sum + `${note.title} ${note.body}`.split(/\s+/).filter(Boolean).length, 0);
      return { notes: notes.length, tags: tags.size, words };
    },
  };
}
