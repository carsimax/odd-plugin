# text-table

Renders rows of plain objects as an aligned text table for terminals and logs.

- `renderTable(columns, rows)` (`src/table.js`): the renderer; its behavior is specified in `docs/SPEC.md`.
- `displayWidth(text)` (`src/width.js`): width of a string in terminal cells.
- `padCell(text, width, align)` (`src/pad.js`): pads a string to a width.
- `TableError` (`src/errors.js`): the error class thrown for invalid input.

Run the tests with `npm test`.
