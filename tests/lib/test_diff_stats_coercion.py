"""Differential: renderStats on subagent records whose timestamps are not numbers (hand-edited state)."""
from odd_claude.lib import stats as st

from .v9_oracle import needs_v9, v9_many

pytestmark = needs_v9

SUBS = [
    [{"id": "a", "type": "t", "startedAt": None, "endedAt": 5}],
    [{"id": "a", "type": "t", "startedAt": 0, "endedAt": None}],
    [{"id": "b", "type": "t", "startedAt": "100", "endedAt": 5000}],
    [{"id": "c", "type": "t", "startedAt": True, "endedAt": 2000}],
    [{"id": "d", "type": "t", "startedAt": "x", "endedAt": 5000}],
    [{"id": "e", "type": "t", "startedAt": "", "endedAt": "61000"}, {"id": "z", "type": "t", "startedAt": 0, "endedAt": 1000}],
]


def test_render_stats_coerces_like_js():
    want = v9_many("stats", "renderStats", [[{"subagents": s}] for s in SUBS])
    assert [st.render_stats(st.StatsView(None, s, None, None)) for s in SUBS] == want
