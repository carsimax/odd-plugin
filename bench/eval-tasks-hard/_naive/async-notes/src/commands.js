import { applyOps } from "./batch.js";

const describe = (note) => `#${note.id} ${note.title}${note.tags.length ? ` [${note.tags.join(",")}]` : ""}`;

export const commands = {
  async add(app, [title, ...body]) {
    const note = await app.notes.create({ title, body: body.join(" ") });
    return `Added note ${note.id}`;
  },

  async show(app, [id]) {
    const note = await app.notes.get(id);
    return note ? `${describe(note)}\n${note.body}` : `Note ${id} not found`;
  },

  async list(app) {
    const notes = await app.notes.list();
    return notes.length === 0 ? "No notes." : notes.map(describe).join("\n");
  },

  async rm(app, [id]) {
    return (await app.notes.remove(id)) ? `Removed note ${id}` : `Note ${id} not found`;
  },

  async tag(app, [id, tag]) {
    return (await app.notes.addTag(id, tag)) ? `Tagged note ${id} with ${tag}` : `Note ${id} not found`;
  },

  async tags(app) {
    const tags = await app.tags.allTags();
    return tags.length === 0 ? "No tags." : tags.join(", ");
  },

  async stats(app) {
    const { notes, tags, words } = await app.stats.summary();
    return `Notes: ${notes}\nTags: ${tags}\nWords: ${words}`;
  },

  // import '[{"id":7,"title":"x","body":"","tags":[]}]': stores notes whose id is not taken yet.
  async import(app, [json]) {
    const notes = JSON.parse(json);
    const taken = await applyOps(app.store, notes.map((note) => ({ type: "has", args: [`note:${note.id}`] })));
    const fresh = notes.filter((note, i) => !taken[i]);
    await applyOps(app.store, fresh.map((note) => ({ type: "set", args: [`note:${note.id}`, note] })));
    const top = Math.max((await app.store.get("meta:counter")) ?? 0, ...fresh.map((note) => note.id));
    await app.store.set("meta:counter", top);
    return `Imported ${fresh.length} notes, skipped ${notes.length - fresh.length}`;
  },
};
