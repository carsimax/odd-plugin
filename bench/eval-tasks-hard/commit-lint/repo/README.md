# commit-lint

Checks commit messages against the team conventions, for use in a `commit-msg` hook.

- `lintCommit(message, options)` (`src/lint.js`): returns the list of problems; specified in `docs/SPEC.md`.
- `parseMessage(raw)` (`src/parse.js`): splits a raw message into lines.
- `charLength(text)` (`src/text.js`): length in characters (code points).
- `COMMIT_TYPES` (`src/types.js`): the allowed commit types.
- `formatProblems(problems)` (`src/format.js`): one `line N: message [rule]` row per problem for the hook output.

Run the tests with `npm test`.
