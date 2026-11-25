export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let wasQuoted = false;
  const endField = () => {
    row.push(field);
    field = "";
    wasQuoted = false;
  };
  const endRow = () => {
    const blank = row.length === 0 && field === "" && !wasQuoted;
    if (!blank) {
      endField();
      rows.push(row);
    }
    field = "";
    wasQuoted = false;
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
      wasQuoted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\r" && text[i + 1] === "\n") {
      continue;
    } else if (c === "\n") {
      endRow();
    } else {
      field += c;
    }
  }
  if (field !== "" || wasQuoted || row.length > 0) endRow();
  return rows;
}

export function parseCsvWithHeader(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""])));
}
