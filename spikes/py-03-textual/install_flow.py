# /// script
# requires-python = ">=3.14"
# dependencies = ["textual"]
# ///
"""Throwaway spike: the v9 `install` flow (welcome > profile > models > extras > review > installing > complete) in Textual.
Services are stubbed: no side effects."""
import asyncio

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Footer, Header, OptionList, SelectionList, Static

MODELS = ["haiku", "sonnet", "opus"]
ROLES = ["odd-worker", "odd-explore", "odd-verify"]
PROFILES = {"economy": [0, 0, 1], "balanced": [1, 0, 2], "quality": [2, 1, 2]}
EXTRAS = [("Status line", "statusLine"), ("Sync claude.ai", "claudeAi")]


class StubServices:
    """Stands in for services.ts (detect/plan/run); records the request instead of installing."""
    def __init__(self) -> None:
        self.ran: dict | None = None

    async def run(self, req: dict, on_step):
        for label in ("backup settings.json", "write hooks", "register MCP"):
            await asyncio.sleep(0)
            on_step(("ok", label))
        self.ran = req
        return True


class Base(Screen):
    BINDINGS = [Binding("escape", "back", "Back"), Binding("q", "app.quit", "Quit")]
    TITLE_TEXT = ""

    def action_back(self) -> None:
        if len(self.app.screen_stack) > 2:
            self.app.pop_screen()

    def compose(self) -> ComposeResult:
        yield Header()
        yield from self.body()
        yield Footer()

    def on_mount(self) -> None:
        self.sub_title = self.TITLE_TEXT


class Welcome(Base):
    TITLE_TEXT = "Welcome"

    def body(self):
        yield OptionList("Install", "Update", "Configure models", "Manage backups", "Uninstall", "Quit")

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        if e.option_index == 0:
            self.app.push_screen(Profile())  # other flows: same screen classes, different route
        elif e.option_index == 5:
            self.app.exit()


class Profile(Base):
    TITLE_TEXT = "Profile"

    def body(self):
        yield OptionList(*PROFILES)

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        name = list(PROFILES)[e.option_index]
        self.app.sel = {"profile": name, "roles": list(PROFILES[name])}
        self.app.push_screen(Models())


class Models(Base):
    TITLE_TEXT = "Models"
    BINDINGS = Base.BINDINGS + [
        Binding("up", "row(-1)", "role"), Binding("down", "row(1)", "role"),
        Binding("left", "cycle(-1)", "model"), Binding("right", "cycle(1)", "model"),
        Binding("enter", "next", "Continue"),
    ]
    row = 0

    def body(self):
        yield Static(id="grid")

    def on_mount(self) -> None:
        super().on_mount()
        self.draw()

    def draw(self) -> None:
        roles = self.app.sel["roles"]
        lines = [f"{'>' if i == self.row else ' '} {r:<14}" + " ".join(f"[{m}]" if roles[i] == j else f" {m} " for j, m in enumerate(MODELS)) for i, r in enumerate(ROLES)]
        self.query_one("#grid", Static).update("\n".join(lines))

    def action_row(self, d: int) -> None:
        self.row = (self.row + d) % len(ROLES)
        self.draw()

    def action_cycle(self, d: int) -> None:
        roles = self.app.sel["roles"]
        roles[self.row] = (roles[self.row] + d) % len(MODELS)
        self.app.sel["profile"] = next((p for p, v in PROFILES.items() if v == roles), "custom")
        self.draw()

    def action_next(self) -> None:
        self.app.push_screen(Extras())


class Extras(Base):
    TITLE_TEXT = "Extras"
    BINDINGS = Base.BINDINGS + [Binding("enter", "next", "Continue", priority=True)]  # SelectionList would swallow enter

    def body(self):
        yield SelectionList[str](*[(label, key, key == "statusLine") for label, key in EXTRAS])

    def action_next(self) -> None:
        self.app.sel["extras"] = list(self.query_one(SelectionList).selected)
        self.app.push_screen(Review())


class Review(Base):
    TITLE_TEXT = "Review"
    BINDINGS = Base.BINDINGS + [Binding("enter", "run", "Run")]

    def body(self):
        s = self.app.sel
        yield Static(f"profile {s['profile']}\nextras {', '.join(s['extras']) or 'none'}")

    def action_run(self) -> None:
        self.app.push_screen(Installing())


class Installing(Base):
    TITLE_TEXT = "Working"
    BINDINGS = []  # v9 locks keys while running

    def body(self):
        yield Static("", id="steps")

    def on_mount(self) -> None:
        super().on_mount()
        self.run_worker(self.go(), exclusive=True)

    async def go(self) -> None:
        lines: list[str] = []
        ok = await self.app.services.run(self.app.sel, lambda s: (lines.append(f"{s[0]:<4} {s[1]}"), self.query_one("#steps", Static).update("\n".join(lines))))
        self.app.switch_screen(Complete(ok, lines))


class Complete(Base):
    TITLE_TEXT = "Complete"
    BINDINGS = [Binding("enter", "menu", "Menu"), Binding("q", "app.quit", "Quit")]

    def __init__(self, ok: bool, lines: list[str]) -> None:
        super().__init__()
        self.ok, self.lines = ok, lines

    def body(self):
        yield Static(("Installed.\n" if self.ok else "Failed.\n") + "\n".join(self.lines), id="done")

    def action_menu(self) -> None:
        while len(self.app.screen_stack) > 2:
            self.app.pop_screen()


class InstallApp(App):
    TITLE = "odd-claude"

    def __init__(self, services=None) -> None:
        super().__init__()
        self.services = services or StubServices()
        self.sel: dict = {}

    def on_mount(self) -> None:
        self.push_screen(Welcome())


if __name__ == "__main__":
    InstallApp().run()
