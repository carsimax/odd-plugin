export function formatProblems(problems) {
  return problems.map((p) => `line ${p.line}: ${p.message} [${p.rule}]`).join("\n");
}
