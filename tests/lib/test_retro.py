import json
import os

import pytest

from odd_claude.lib.retro import collect_retro, render_retro, retro_json
from odd_claude.lib.transcript_tail import STATS_MAX_LINE_BYTES, STATS_TAIL_BYTES


# Synthetic fixtures only, written under tmp_path; no real transcript, no personal data.
def user(content, **extra):
    return json.dumps({"type": "user", "message": {"role": "user", "content": content}, **extra})


def use(id, name, input, **extra):
    return json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}, **extra})


def result(id, is_error=None, **extra):
    block = {"type": "tool_result", "tool_use_id": id, "content": "SECRET-BODY", **({} if is_error is None else {"is_error": is_error})}
    return json.dumps({"type": "user", "message": {"role": "user", "content": [block]}, **extra})


@pytest.fixture
def digest(tmp_path):
    def run(lines):
        p = tmp_path / "t.jsonl"
        p.write_text("\n".join(lines))
        return collect_retro(str(p))

    return run


def test_human_prompts_only_typed_user_records_count_with_1_based_line_numbers(digest):
    d = digest(
        [
            user("first human prompt"),  # 1
            use("a", "Read", {"file_path": "/p/a.ts"}),  # 2
            result("a"),  # 3 tool result, not a prompt
            user([{"type": "text", "text": "second prompt"}]),  # 4
            user("reminder", isMeta=True),  # 5
            user("compact summary", isCompactSummary=True),  # 6
            user("sidechain prompt", isSidechain=True),  # 7
            user("   "),  # 8 empty
            user([{"type": "text", "text": "x"}, {"type": "tool_result", "tool_use_id": "a"}]),  # 9 carries a tool_result
        ]
    )
    assert d.prompts.model_dump() == {"count": 2, "lines": [1, 4]}
    assert d.schema_ == "odd-claude.retro/v1"


def test_tool_counts_by_name_duplicated_ids_count_once_sidechain_skipped(digest):
    d = digest(
        [
            use("a", "Read", {"file_path": "/p/a.ts"}),
            use("a", "Read", {"file_path": "/p/a.ts"}),
            use("b", "Bash", {"command": "npm test"}),
            use("c", "Read", {"file_path": "/p/b.ts"}),
            use("s", "Grep", {"pattern": "x"}, isSidechain=True),
        ]
    )
    assert [t.model_dump() for t in d.tools] == [{"name": "Read", "count": 2}, {"name": "Bash", "count": 1}]


def test_tool_errors_report_tool_name_and_line_non_errors_are_not_listed(digest):
    d = digest(
        [
            use("a", "Bash", {"command": "npm test"}),  # 1
            result("a", True),  # 2
            use("b", "Read", {"file_path": "/p/a.ts"}),  # 3
            result("b", False),  # 4
            use("c", "Edit", {"file_path": "/p/a.ts"}),  # 5
            result("c", True),  # 6
            result("zzz", True),  # 7 unknown id
        ]
    )
    assert [e.model_dump() for e in d.errors.items] == [{"tool": "Bash", "line": 2}, {"tool": "Edit", "line": 6}, {"tool": "unknown", "line": 7}]
    assert d.errors.count == 3


def test_files_read_3_plus_and_edited_2_plus_with_lines_and_main_thread_flag(digest):
    d = digest(
        [
            use("r1", "Read", {"file_path": "/p/a.ts"}),  # 1
            use("r2", "Read", {"file_path": "/p/a.ts"}),  # 2
            use("r3", "Read", {"file_path": "/p/a.ts"}),  # 3
            use("r4", "Read", {"file_path": "/p/b.ts"}),  # 4
            use("r5", "Read", {"file_path": "/p/b.ts"}),  # 5
            use("e1", "Edit", {"file_path": "/p/c.ts"}),  # 6
            use("e2", "Write", {"file_path": "/p/c.ts"}),  # 7
            use("e3", "Edit", {"file_path": "/p/d.ts"}),  # 8
            use("e4", "Edit", {"file_path": "/p/a.ts"}, isSidechain=True),  # 9 ignored
            use("e5", "Edit", {"file_path": "/p/d.ts"}, isSidechain=True),  # 10 ignored
        ]
    )
    assert [r.model_dump() for r in d.rereads] == [{"file": "/p/a.ts", "count": 3, "lines": [1, 2, 3]}]
    assert [r.model_dump() for r in d.reedits] == [{"file": "/p/c.ts", "count": 2, "lines": [6, 7], "mainThread": True}]


def test_bash_commands_repeated_2_plus_exactly_exempt_git_status_diff_ls_pwd(digest):
    cmds = ["npm test", "npm test", "npm  test ", "git status", "git status", "git diff --stat", "git diff --stat", "ls", "ls", "pwd", "pwd", "npm run build", "git statusx", "git statusx"]
    d = digest([use(str(i), "Bash", {"command": c}) for i, c in enumerate(cmds)])
    assert [r.model_dump() for r in d.repeatedCommands] == [
        {"command": "npm test", "count": 3, "lines": [1, 2, 3]},
        {"command": "git statusx", "count": 2, "lines": [13, 14]},
    ]


def test_agent_task_launches_by_type_and_model_worker_without_allowed_edit_surfaces_is_flagged(digest):
    d = digest(
        [
            use("1", "Agent", {"subagent_type": "odd-worker", "model": "sonnet", "prompt": "do it"}),  # 1 flagged
            use("2", "Task", {"subagent_type": "odd-worker", "prompt": "x\n## Allowed edit surfaces\n- a"}),  # 2 ok
            use("3", "Agent", {"subagent_type": "Explore", "model": "haiku", "prompt": "look"}),  # 3 not a worker
            use("4", "Agent", {"prompt": "no type"}),  # 4
        ]
    )
    assert [a.model_dump() for a in d.agents] == [
        {"line": 1, "subagentType": "odd-worker", "model": "sonnet", "missingEditSurfaces": True},
        {"line": 2, "subagentType": "odd-worker", "model": "", "missingEditSurfaces": False},
        {"line": 3, "subagentType": "Explore", "model": "haiku", "missingEditSurfaces": False},
        {"line": 4, "subagentType": "", "model": "", "missingEditSurfaces": False},
    ]


def test_legacy_plugin_namespaced_odd_worker_transcripts_are_still_flagged(digest):
    d = digest(
        [
            use("1", "Agent", {"subagent_type": "odd-claude:odd-worker", "model": "sonnet", "prompt": "do it"}),
            use("2", "Task", {"subagent_type": "odd-claude:odd-worker", "prompt": "x\n## Allowed edit surfaces\n- a"}),
            use("3", "Agent", {"subagent_type": "odd-claude:odd-explore", "prompt": "look"}),
        ]
    )
    assert [a.missingEditSurfaces for a in d.agents] == [True, False, False]
    assert [a.subagentType for a in d.agents][0] == "odd-claude:odd-worker"


def test_compaction_records_first_source_write_and_first_feature_document_write(digest):
    d = digest(
        [
            use("1", "Read", {"file_path": "/p/a.ts"}),  # 1
            json.dumps({"type": "system", "subtype": "compact_boundary"}),  # 2
            user("summary", isCompactSummary=True),  # 3
            use("2", "Write", {"file_path": "/p/odd/tasks/feat.md"}),  # 4 feature doc
            use("3", "Edit", {"file_path": "/p/src/a.ts"}),  # 5 first source write
            use("4", "Edit", {"file_path": "/p/odd/tasks/feat.md"}),  # 6
        ]
    )
    assert d.compactions == [2, 3]
    assert d.firstSourceWrite == 5
    assert d.firstFeatureDoc == 4
    none = digest([use("1", "Read", {"file_path": "/p/a.ts"})])
    assert none.firstSourceWrite is None and none.firstFeatureDoc is None and none.compactions == []


def test_malformed_non_object_field_less_and_oversized_lines_are_skipped_without_shifting_line_numbers(digest):
    huge = json.dumps({"type": "user", "message": {"content": "h" * (STATS_MAX_LINE_BYTES + 10)}})
    d = digest(
        [
            "not json",  # 1
            "42",  # 2
            "null",  # 3
            json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use"}, None, "x", {"type": "tool_use", "id": "k", "name": "Read", "input": None}]}}),  # 4
            huge,  # 5
            json.dumps({"type": "user"}),  # 6
            user("real prompt"),  # 7
        ]
    )
    assert d.prompts.model_dump() == {"count": 1, "lines": [7]}
    assert [t.model_dump() for t in d.tools] == [{"name": "Read", "count": 1}]
    assert d.lines == 7


def test_strings_are_control_character_cleaned_and_capped_at_160_bodies_never_printed(digest):
    cmd = "echo " + "x" * 300
    bad = "/p/\x1b[31mred\x07‮.ts"
    d = digest(
        [
            user("PROMPT-BODY-TEXT"),
            use("1", "Bash", {"command": cmd}),
            use("2", "Bash", {"command": cmd}),
            use("3", "Read", {"file_path": bad}),
            use("4", "Read", {"file_path": bad}),
            use("5", "Read", {"file_path": bad}),
            result("1", True),
        ]
    )
    assert len(d.repeatedCommands[0].command) == 160
    assert d.rereads[0].file == "/p/red.ts"
    for out in (render_retro(d), retro_json(d)):
        assert "PROMPT-BODY-TEXT" not in out
        assert "SECRET-BODY" not in out
        assert not any(c in out for c in "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x1b\x7f‮")


def test_tail_cap_a_large_transcript_reports_truncated_and_reads_at_most_the_tail(tmp_path):
    p = tmp_path / "t.jsonl"
    line = user("p" * 1000) + "\n"
    p.write_text(line * (-(-(STATS_TAIL_BYTES + 5000) // len(line))))
    d = collect_retro(str(p))
    assert d.truncated is True
    assert d.bytesRead <= STATS_TAIL_BYTES
    assert "partial: only the last" in render_retro(d)


def test_unreadable_missing_and_fifo_transcripts_give_none_without_hanging(tmp_path):
    assert collect_retro(str(tmp_path / "missing.jsonl")) is None
    fifo = tmp_path / "f.jsonl"
    os.mkfifo(fifo)
    assert collect_retro(str(fifo)) is None
    assert collect_retro(str(tmp_path)) is None


def test_render_retro_prints_the_sections_with_line_numbers(digest):
    d = digest([user("hi"), use("1", "Bash", {"command": "npm test"}), use("2", "Bash", {"command": "npm test"}), result("2", True)])
    assert render_retro(d) == "\n".join(
        [
            "odd-claude retro (local transcript digest)",
            "lines      4 read",
            "first line read  1 (all line numbers are absolute in the transcript file)",
            "prompts    1 (lines 1)",
            "tools      Bash 2",
            "errors     1 · Bash @4",
            "repeat     npm test x2 (lines 2, 3)",
            "first source write  none",
            "first feature doc   none",
        ]
    )


def test_truncated_tail_reported_line_numbers_are_absolute(tmp_path):
    p = tmp_path / "t.jsonl"
    allv = [use("e390", "Edit", {"file_path": "/p/src/late.ts"}) if i == 390 else user(f"prompt number {i} {'z' * (i % 7)}") for i in range(1, 401)]
    p.write_text("\n".join(allv) + "\n")
    d = collect_retro(str(p), 4096)
    assert d.truncated is True
    assert d.firstLine > 1
    assert d.firstSourceWrite == 390
    assert "late.ts" in allv[d.firstSourceWrite - 1]
    assert d.prompts.lines[0] == d.firstLine
    assert d.prompts.count == 400 - d.firstLine + 1 - 1  # lines firstLine..400 minus the Edit at 390
    assert d.firstLine + d.lines - 1 == 401  # trailing empty line after the final newline
    assert f"first line read  {d.firstLine} " in render_retro(d)


def test_untruncated_transcript_starts_at_line_1(digest):
    assert digest([user("hi")]).firstLine == 1


def test_retro_json_carries_the_schema_and_omits_unset_fields(digest):
    d = digest([user("hi"), use("1", "Read", {"file_path": "/p/a.ts"})])
    j = json.loads(retro_json(d))
    assert j["schema"] == "odd-claude.retro/v1"
    assert j["prompts"] == {"count": 1, "lines": [1]}
    assert "firstSourceWrite" not in j and "firstFeatureDoc" not in j
    assert retro_json(d).startswith('{\n  "schema": "odd-claude.retro/v1",\n  "lines": 2,')


def test_tools_tie_break_is_by_name_and_agent_with_no_model_prints_without_it(digest):
    d = digest([use("1", "bash", {}), use("2", "Zed", {}), use("3", "Alpha", {}), use("4", "Agent", {"subagent_type": "Explore"}), user("x")])
    assert [t.name for t in d.tools] == ["Agent", "Alpha", "bash", "Zed"]
    assert "agent      Explore @4" in render_retro(d).splitlines()
    assert "compact    lines" not in render_retro(d)
