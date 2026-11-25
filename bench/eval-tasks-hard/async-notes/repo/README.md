# notes

A small notes app with a key-value store behind it.

## Layout

- `src/store.js`: `MemoryStore`, the Store implementation. A Store has `get(key)`, `set(key, value)`, `has(key)`, `delete(key)` and `keys(prefix)`.
- `src/services/notes.js`: create, get, list, remove and tag notes (`note:<id>` keys, id counter in `meta:counter`).
- `src/services/tags.js`: look notes up by tag.
- `src/services/stats.js`: totals over all notes.
- `src/batch.js`: `applyOps(store, ops)` runs a list of `{ type, args }` operations (`type` is a Store method name) and returns their results in order.
- `src/commands.js`: the CLI commands, keyed by name.
- `src/cli.js`: `run(app, argv)` looks a command up and returns its output.
- `src/index.js`: `createApp(store)` wires everything together.

Commands: `add <title> [body...]`, `show <id>`, `list`, `rm <id>`, `tag <id> <tag>`, `tags`, `stats`, `import <json>`.

Run the tests with `npm test`.
