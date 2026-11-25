# lintCommit specification

`lintCommit(message, options = {})` returns an array of problems, `[]` when the message is fine.
A problem is `{ rule, line, message }` where `line` is the 1-based line number in the message.
`options.headerMax` (default 72) and `options.bodyMax` (default 100) set the length limits.

## Lines

The message is split with `parseMessage`. Line 1 is the header. A line that starts with `#` at line 2 or later is a comment: every rule skips it, but it still counts for line numbers.
Lengths are counted in characters (code points) with `charLength`, including any trailing whitespace.

## Rules

Rules are listed in rule order. A rule is checked on the lines named in its row.

| rule | line | fires when | message |
|---|---|---|---|
| `header-empty` | 1 | the header is empty or only whitespace | `header must not be empty` |
| `header-format` | 1 | the header is not empty and does not match `^(feat\|fix\|docs\|refactor\|test\|chore)(\([a-z0-9-]+\))?!?: \S.*$` | `header must look like "type(scope): subject"` |
| `header-length` | 1 | the header is not empty and is longer than `headerMax` | `header is N characters, the limit is MAX` |
| `subject-case` | 1 | the header matches the format and the subject starts with an uppercase letter | `subject must not start with an uppercase letter` |
| `subject-period` | 1 | the header matches the format and the subject, ignoring trailing whitespace, ends with `.` | `subject must not end with a period` |
| `body-separator` | 2 | line 2 exists, is not a comment and is not blank | `header and body must be separated by a blank line` |
| `body-line-length` | every line from 2 | the line is longer than `bodyMax` | `line is N characters, the limit is MAX` |
| `trailing-whitespace` | every line from 1 | the line ends with a space or a tab | `line has trailing whitespace` |

The subject is the text after the first `: ` of the header. `N` and `MAX` in a message are the actual length and the limit as plain numbers.

Exceptions:

- A line from 2 on that is a single `http://` or `https://` URL (no whitespace in it) is exempt from `body-line-length`.
- Comment lines are skipped by all rules.

## Order

Problems are sorted by `line` ascending; problems on the same line follow rule order. A line gets each rule at most once.
