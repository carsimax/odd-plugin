export class TableError extends Error {
  constructor(message) {
    super(message);
    this.name = "TableError";
  }
}
