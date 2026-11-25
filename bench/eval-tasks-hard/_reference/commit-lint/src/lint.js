import { parseMessage } from "./parse.js";
import { charLength } from "./text.js";
import { COMMIT_TYPES } from "./types.js";

const HEADER = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: (\\S.*)$`);
const URL_ONLY = /^https?:\/\/\S+$/;

export function lintCommit(message, options = {}) {
  const { headerMax = 72, bodyMax = 100 } = options;
  const lines = parseMessage(message);
  const problems = [];
  const add = (rule, line, text) => problems.push({ rule, line, message: text });

  lines.forEach((text, index) => {
    const line = index + 1;
    if (line >= 2 && text.startsWith("#")) return;

    if (line === 1) {
      const header = text;
      if (header.trim() === "") {
        add("header-empty", 1, "header must not be empty");
      } else {
        const match = HEADER.exec(header);
        if (!match) add("header-format", 1, 'header must look like "type(scope): subject"');
        const length = charLength(header);
        if (length > headerMax) add("header-length", 1, `header is ${length} characters, the limit is ${headerMax}`);
        if (match) {
          const subject = match[3];
          if (/^\p{Lu}/u.test(subject)) add("subject-case", 1, "subject must not start with an uppercase letter");
          if (subject.trimEnd().endsWith(".")) add("subject-period", 1, "subject must not end with a period");
        }
      }
    } else {
      if (line === 2 && text.trim() !== "") add("body-separator", 2, "header and body must be separated by a blank line");
      const length = charLength(text);
      if (length > bodyMax && !URL_ONLY.test(text)) add("body-line-length", line, `line is ${length} characters, the limit is ${bodyMax}`);
    }
    if (/[ \t]$/.test(text)) add("trailing-whitespace", line, "line has trailing whitespace");
  });
  return problems;
}
