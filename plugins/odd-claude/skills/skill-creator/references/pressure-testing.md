# Pressure-testing discipline skills

A discipline skill holds rules an agent is tempted to bypass, or rules that cost compliance effort. Test it like code: watch it fail first, then fix only what failed.

## Loop

1. RED: run the scenario with a fresh subagent without the skill; record its choice and its rationalizations word for word.
2. GREEN: write only the counters those observed failures need; rerun the same scenario with the skill.
3. REFACTOR: give each new rationalization an explicit counter (an Excuse | Reality table row or a red-flag line), then retest until it holds.

## Pressure types

time, sunk cost (hours already invested), authority (a boss or maintainer says it is not needed), economic (cost or deadline consequences), exhaustion (a long session), social (looking rigid or slow), pragmatic ("be pragmatic, not dogmatic"). Stack them.

## Scenario shape

- Frame a real situation with concrete details: paths, hours invested, consequences.
- Use at least three stacked pressures.
- End with a forced A/B/C choice asked as "What do you do?", an action, not what the agent should do.
- Make one option compliant, one a clear violation, one a plausible hybrid.

## Verdict

- Pass: picks the compliant option, cites the skill, names the temptation.
- Fail: a new rationalization, argues the skill is wrong, or picks a hybrid.

## Scope

- Required for discipline skills, new or edited.
- Not needed for pure reference or technique-lookup skills with no rule to break; say so in the report.

## Fixing failures

Prohibitions only fix discipline failures. When the output has the wrong shape, fix it by changing the form (template, example, output contract), not by adding "never".

Use `assets/pressure-scenario.md` as the skeleton and results block.
