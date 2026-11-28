"""Launcher of the review server: `python <this file>` (the phase 0 command shape, `<venv>/bin/python <launcher>`) or `python -m odd_claude.mcp`."""
import os
import sys

if not __package__:  # run by path: this directory holds modules named like third-party ones (jsonschema), so keep it off sys.path
    _here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]

from odd_claude.mcp.review_server import main  # noqa: E402

sys.exit(main())
