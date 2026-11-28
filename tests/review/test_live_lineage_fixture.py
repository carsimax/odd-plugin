"""Port of v9 review/live-lineage-fixture.spec.ts (the Phase 1 guard): the frozen `reviewing` lineage that the crash contract
plants (v9 `src/contract/store.testkit.ts`: LIVE_LINEAGE / LIVE_STATE, `plantLiveLineage`) must stay byte-identical, content
and mode, to what the Python store writes for the same start() input."""
import os
from pathlib import Path

from odd_claude.review.state import start
from odd_claude.review.store import create_state, store_root_for

LIVE_LINEAGE = "review-000000000000feed"
LIVE_STATE = (
    '{"admitted_role_results":[],"base_tree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","burned":false,"candidate_tree":"cccccccccccccccccccccccccccccccccccccccc",'
    '"correction_attempts":0,"correction_budget":4,"correction_budget_policy":"floor_two","created_at":"2026-11-19T10:00:00.000Z","findings":[],'
    '"fix_finding_ids":[],"lineage_id":"review-000000000000feed","original_changed_lines":8,"projection":"workspace",'
    '"revision":"sha256:402a9e3e167bccfd234188bc234eb19f88a5ad786e0745a0aed19555f4bdc91f","risk_level":"medium","schema":"odd-claude.review-state/v2",'
    '"selected_lenses":["reliability"],"state":"reviewing",'
    '"target_identity":"sha256:7777777777777777777777777777777777777777777777777777777777777777","updated_at":"2026-11-19T10:00:00.000Z"}\n'
)


def plant_live_lineage(common_dir: str) -> None:
    """Mirror of the TS testkit: the store directories (0700) and the live lineage as the store lays them out."""
    path = common_dir
    for part in ("odd-plugin", "review-transactions", "v2"):
        path = os.path.join(path, part)
        if not os.path.exists(path):
            os.mkdir(path, 0o700)
    d = os.path.join(path, LIVE_LINEAGE)
    os.mkdir(d, 0o700)
    fd = os.open(os.path.join(d, "review-state.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(LIVE_STATE)


def test_the_frozen_live_lineage_of_the_crash_contract_is_byte_identical_to_what_the_store_writes(tmp_path):
    a, b = str(tmp_path / "a"), str(tmp_path / "b")
    os.mkdir(a)
    os.mkdir(b)
    out = start({
        "lineageId": LIVE_LINEAGE, "targetIdentity": f"sha256:{'7' * 64}", "projection": "workspace", "baseTree": "b" * 40, "candidateTree": "c" * 40,
        "riskLevel": "medium", "selectedLenses": ["reliability"], "originalChangedLines": 8, "now": "2026-11-19T10:00:00.000Z",
    })
    assert out["ok"] is True
    create_state(a, out["record"])
    plant_live_lineage(b)

    def f(c):
        return os.path.join(store_root_for(c), LIVE_LINEAGE, "review-state.json")

    assert Path(f(b)).read_text(encoding="utf-8") == Path(f(a)).read_text(encoding="utf-8")
    assert os.stat(f(b)).st_mode & 0o777 == os.stat(f(a)).st_mode & 0o777
