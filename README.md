# odd-claude

odd-claude is a Claude Code plugin marketplace whose first plugin, `odd-claude`, ports the ODD harness to Claude Code. v0.1 is the installable skeleton: Engram dependency, `/odd-doctor`, `/odd-status` and an opt-in `/odd-setup`.

Install (engram is required: `plugin.json` declares `dependencies: ["engram@engram"]`, so add its marketplace first):

```
/plugin marketplace add Gentleman-Programming/engram
/plugin marketplace add carsimax/odd-plugin
/plugin install odd-claude@odd-claude
```

From a terminal: `claude plugin marketplace add Gentleman-Programming/engram`, `claude plugin marketplace add carsimax/odd-plugin`, `claude plugin install odd-claude@odd-claude`. Without the engram marketplace the install warns that `odd-claude` will not load without it. The repository is private: the installer needs GitHub access (for example `gh auth login`).

- [Plugin README](plugins/odd-claude/README.md): install, commands, development
- [Docs](docs/README.md): decisions and research
- [Roadmap](docs/roadmap.md): phases and status
