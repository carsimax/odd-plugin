# csv

A small CSV reader.

- `parseCsv(text)`: returns an array of rows, each an array of string fields. Blank lines are skipped.
- `parseCsvWithHeader(text)`: uses the first row as keys and returns an array of objects. Missing fields become `""`.

Run the tests with `npm test`.
