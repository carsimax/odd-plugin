# /// script
# requires-python = ">=3.14"
# dependencies = ["textual", "pytest", "pytest-asyncio"]
# ///
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from install_flow import Complete, InstallApp, Models, Review, StubServices


async def test_install_flow_end_state():
    svc = StubServices()
    app = InstallApp(svc)
    async with app.run_test() as pilot:
        await pilot.press("enter")            # Welcome: Install
        await pilot.press("down", "enter")    # Profile: balanced
        assert isinstance(app.screen, Models)
        await pilot.press("right")            # odd-worker sonnet -> opus: preset no longer matches
        await pilot.press("enter")            # Models -> Extras
        await pilot.press("down", "space")    # toggle claudeAi on
        await pilot.press("enter")            # Extras -> Review
        assert isinstance(app.screen, Review)
        await pilot.press("enter")            # run
        for _ in range(50):
            await pilot.pause()
            if isinstance(app.screen, Complete):
                break
        assert isinstance(app.screen, Complete)
        assert svc.ran == {"profile": "custom", "roles": [2, 0, 2], "extras": ["statusLine", "claudeAi"]}
        assert "register MCP" in str(app.screen.query_one("#done").render())
        await pilot.press("enter")            # back to the menu
        assert type(app.screen).__name__ == "Welcome"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider", "-o", "asyncio_mode=auto"]))
