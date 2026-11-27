"""S2: the tasks-lint output schema fixture (`output-schemas/tasks-lint.json`, input `feature.md`)."""
import os
import shutil
import subprocess

from odd_claude.lib.feature_doc import lint_feature_docs, tasks_lint_json
from .conftest import FIXTURES, fixture_text


def test_tasks_lint_json_is_byte_identical_to_the_fixture(tmp_path):
    repo = str(tmp_path / "tasksrepo")
    os.makedirs(os.path.join(repo, "odd", "tasks"))
    subprocess.run(["git", "-C", repo, "init", "-q", "-b", "main"], check=True, capture_output=True)
    shutil.copyfile(FIXTURES / "output-schemas" / "feature.md", os.path.join(repo, "odd", "tasks", "feature.md"))
    lint = lint_feature_docs(repo)
    assert lint is not None
    assert tasks_lint_json(lint) + "\n" == fixture_text("output-schemas/tasks-lint.json")
