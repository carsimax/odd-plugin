# renderTable specification

`renderTable(columns, rows)` returns a string.

## Input

- `columns`: a non-empty array of `{ key, title?, align?, maxWidth? }`.
  - `key`: a non-empty string, the property read from each row.
  - `title`: the header text; defaults to `key`.
  - `align`: `"left"` or `"right"`. When omitted, a column is `"right"` if it has at least one non-null cell and every non-null cell is a number, otherwise `"left"`.
  - `maxWidth`: an integer of at least 2, the widest the column may be.
- `rows`: an array of objects. A key missing from a row counts as `null`.

## Cell text

1. `null` and `undefined` become the empty string; booleans become `yes` or `no`; a `Date` becomes its UTC date as `YYYY-MM-DD`; every other value becomes `String(value)`.
2. Then each `\r\n`, `\n` or `\r` becomes the single character `⏎` (U+23CE) and each tab becomes one space.

## Layout

- The width of a text is its number of Unicode code points.
- A column is as wide as its widest text, titles included, but never wider than `maxWidth`.
- A text wider than its column is cut to the first `maxWidth - 1` code points followed by `…` (U+2026). Titles are cut the same way.
- Texts are padded with spaces to the column width following the column alignment, headers too.
- The output has a header line, a separator line, then one line per row, joined with `\n`, with no trailing newline.
- Cells of a line are joined with ` | `. The separator line has `-` repeated to each column width, joined with `-+-`.
- No line ends with a space: trailing spaces are removed from every line.
- If `rows` is empty the output is exactly `(no rows)` and no header is shown.

## Errors

Invalid input throws a `TableError` (`name` is `"TableError"`) with exactly these messages. Checks run in this order, and the first failure is the one reported:

1. `columns` is not a non-empty array: `columns must be a non-empty array`
2. For each column in order, the first of:
   - `key` is not a non-empty string: `column N has no key` (N is the 1-based position)
   - the key was already used by an earlier column: `duplicate column key "KEY"`
   - `align` is set and is not `"left"` or `"right"`: `unknown align "ALIGN" for column "KEY"`
   - `maxWidth` is set and is not an integer of at least 2: `maxWidth for column "KEY" must be an integer of at least 2`
3. `rows` is not an array: `rows must be an array`
4. A row is not a plain object (`null`, arrays and primitives are not): `row N is not an object` (N is the 1-based position)

Validation runs even when `rows` is empty.
