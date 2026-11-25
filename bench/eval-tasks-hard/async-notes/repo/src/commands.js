import { applyOps } from "./batch.js";

const describe = (note) => `#${note.id} ${note.title}${note.tags.length ? ` [${note.tags.join(",")}]` : ""}`;

export const commands = {
  add(app, [title, ...body]) {
    const note = app.notes.create({ title, body: body.join(" ") });
    return `Added note ${note.id}`;
  },

  show(app, [id]) {
    const note = app.notes.get(id);
    return note ? `${describe(note)}\n${note.body}` : `Note ${id} not found`;
  },

  list(app) {
    const notes = app.notes.list();
    return notes.length === 0 ? "No notes." : notes.map(describe).join("\n");
  },

  rm(app, [id]) {
    return app.notes.remove(id) ? `Removed note ${id}` : `Note ${id} not found`;
  },

  tag(app, [id, tag]) {
    return app.notes.addTag(id, tag) ? `Tagged note ${id} with ${tag}` : `Note ${id} not found`;
  },

  tags(app) {
    const tags = app.tags.allTags();
    return tags.length === 0 ? "No tags." : tags.join(", ");
  },

  stats(app) {
    const { notes, tags, words } = app.stats.summary();
    return `Notes: ${notes}\nTags: ${tags}\nWords: ${words}`;
  },

  // import '[{"id":7,"title":"x","body":"","tags":[]}]': stores notes whose id is not taken yet.
  import(app, [json]) {
    const notes = JSON.parse(json);
    const taken = applyOps(app.store, notes.map((note) => ({ type: "has", args: [`note:${note.id}`] })));
    const fresh = notes.filter((note, i) => !taken[i]);
    applyOps(app.store, fresh.map((note) => ({ type: "set", args: [`note:${note.id}`, note] })));
    const top = Math.max(app.store.get("meta:counter") ?? 0, ...fresh.map((note) => note.id));
    app.store.set("meta:counter", top);
    return `Imported ${fresh.length} notes, skipped ${notes.length - fresh.length}`;
  },
};
