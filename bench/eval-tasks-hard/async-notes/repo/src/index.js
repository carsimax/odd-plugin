import { MemoryStore } from "./store.js";
import { createNotes } from "./services/notes.js";
import { createTags } from "./services/tags.js";
import { createStats } from "./services/stats.js";
import { run } from "./cli.js";

export { MemoryStore } from "./store.js";
export { applyOps } from "./batch.js";

export function createApp(store = new MemoryStore()) {
  const app = { store, notes: createNotes(store), tags: createTags(store), stats: createStats(store) };
  app.run = (argv) => run(app, argv);
  return app;
}
