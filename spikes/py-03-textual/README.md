# py-03 Textual feasibility

Spike for roadmap Phase 0: "Textual feasibility for the 5 install/models/update/uninstall/backups flows." v9 reference: `plugins/odd-claude/tui/src/` (`router.ts` route table per flow, `screens.tsx` pure views, `app.tsx` controller, `services.ts` the `Services` seam).

## Result

Mapping rule: each v9 `Screen` becomes a Textual `Screen` subclass; `ROUTES[flow]` becomes `push_screen`/`pop_screen` (Esc = backward); `TITLES` -> `sub_title`; `HINTS` -> `Footer` bindings; `Frame` -> `Header` + `Footer` in a shared base `Screen`; the `Services` interface is injected into the `App` (a stub in the spike); the `installing` screen runs the service in a worker and streams steps.

Widget map (v9 view -> Textual):

| v9 view | Textual |
|---|---|
| `Welcome` menu, `ProfileView`, `BackupsView` (cursor list) | `OptionList` (+ `Static` for the installed/update line) |
| `DetectionView` (status rows) | `DataTable` or `Static` rows with Rich markup |
| `ModelsView` (role x model, left/right cycle) | `Static` + custom bindings (prototyped); `DataTable` is the upgrade path |
| `ExtrasView`, `DepsView`, `ConfirmView` (checkboxes) | `SelectionList` / `Checkbox` |
| `ReviewView`, `CompleteView` | `Static` / `RichLog` |
| `StepList` (live steps) | `Static` updated from a worker (prototyped), `RichLog` or `ListView` for long output |

Verdict per flow:

| Flow | Screens | Verdict |
|---|---|---|
| install | welcome, detection, profile, models, extras, deps, review, installing, complete | Feasible. Prototyped (welcome, profile, models, extras, review, installing, complete; detection and deps are the same read-only/checkbox widgets), driven end to end by a headless pilot. |
| models | welcome, profile, models, review, installing, complete | Feasible. Subset of install, same screen classes with a different route. Prototype covers profile and models. |
| update | welcome, review, installing, complete | Feasible. Subset of install; reviewed on paper. |
| uninstall | welcome, confirm, installing, complete | Feasible. One `Checkbox` (purge) plus the shared installing/complete screens; on paper. |
| backups | welcome, backups, installing, complete | Feasible. `OptionList` of backups then the shared installing/complete screens; on paper. |

Gaps and risks:
- `SelectionList` and `OptionList` consume `enter`; a screen-level "continue" needs `Binding(..., priority=True)` (hit in the spike: the unhandled key leaked to the next screen and skipped Review).
- The prototype stubs services, so real async installer calls, errors and cancellation during `installing` are unproven; v9 locks keys while running, done here by an empty `BINDINGS` on that screen only.
- Render fidelity (colors, widths) is not compared with the ink output; Textual's CSS differs from ink's flexbox.
- Headless test needs `pytest-asyncio` (or `asyncio.run` around `run_test`); the Textual API moves between versions, so pin it.
- Throwaway code: the route table is hand-wired with `push_screen`, a real port should derive it from a per-flow table like `ROUTES`.

## Rerun

Headless (pilot drives welcome through complete, asserts the stub request and the Welcome screen at the end; Python 3.14, PEP 723 script mode, no project):

```
cd spikes/py-03-textual && PYTHONDONTWRITEBYTECODE=1 uv run --script test_install_flow.py
```

Interactive:

```
cd spikes/py-03-textual && uv run --script install_flow.py
```
