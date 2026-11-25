export function createTags(store) {
  return {
    notesByTag(tag) {
      return store
        .keys("note:")
        .filter((key) => store.get(key).tags.includes(tag))
        .map((key) => store.get(key))
        .sort((a, b) => a.id - b.id);
    },

    allTags() {
      const tags = new Set();
      for (const key of store.keys("note:")) {
        for (const tag of store.get(key).tags) tags.add(tag);
      }
      return [...tags].sort();
    },
  };
}
