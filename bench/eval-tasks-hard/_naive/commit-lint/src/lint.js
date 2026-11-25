import { parseMessage } from "./parse.js";
import { charLength } from "./text.js";
import { COMMIT_TYPES } from "./types.js";

const HEADER = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: (\\S.*)$`);

export function lintCommit(message, options = {}) {
  const { headerMax = 72, bodyMax = 100 } = options;
  const lines = parseMessage(message);
  const problems = [];
  const add = (rule, line, text) => problems.push({ rule, line, message: text });

  const header = lines[0];
  if (header.trim() === "") {
    add("header-empty", 1, "header must not be empty");
  } else {
    const match = HEADER.exec(header);
    if (!match) add("header-format", 1, 'header must look like "type(scope): subject"');
    if (header.length > headerMax) add("header-length", 1, `header is too long (max ${headerMax})`);
    if (match) {
      if (/^[A-Z]/.test(match[3])) add("subject-case", 1, "subject must not start with an uppercase letter");
      if (match[3].endsWith(".")) add("subject-period", 1, "subject must not end with a period");
    }
  }
  if (lines.length > 1 && lines[1].trim() !== "") add("body-separator", 2, "header and body must be separated by a blank line");
  lines.slice(1).forEach((text, i) => {
    if (charLength(text) > bodyMax) add("body-line-length", i + 2, `line is too long (max ${bodyMax})`);
  });
  lines.forEach((text, i) => {
    if (/[ \t]$/.test(text)) add("trailing-whitespace", i + 1, "line has trailing whitespace");
  });
  return problems;
}
