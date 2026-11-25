async function allNotes(store) {
  const keys = await store.keys("note:");
  return Promise.all(keys.map((key) => store.get(key)));
}

export function createTags(store) {
  return {
    async notesByTag(tag) {
      const notes = await allNotes(store);
      return notes.filter((note) => note.tags.includes(tag)).sort((a, b) => a.id - b.id);
    },

    async allTags() {
      const tags = new Set();
      for (const note of await allNotes(store)) {
        for (const tag of note.tags) tags.add(tag);
      }
      return [...tags].sort();
    },
  };
}
