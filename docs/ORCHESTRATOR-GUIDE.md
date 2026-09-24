# Running the orchestrator (for Juan)

Runs the board (https://github.com/users/KrishP147/projects/4) unattended: an
Opus planner briefs an issue, a manager + implementer build it on a branch,
the orchestrator merges when tests and CI are green, a verifier updates docs
and the board. Everything it decides is written to `skilleddocs/`.

## One-time setup (10 min)

```bash
# 1. Tools: Node 22+, pnpm 10, Python 3, GitHub CLI, Claude Code
winget install GitHub.cli            # mac: brew install gh
npm i -g pnpm @anthropic-ai/claude-code
gh auth login
gh auth refresh -s project -s read:project   # board access, opens a browser

# 2. Krish's skills + agents (global, one copy for all repos)
git clone https://github.com/KrishP147/skills.git
cd skills && ./scripts/install-skills.sh     # Windows: .\scripts\install-skills.ps1

# 3. This repo
git clone https://github.com/JuanCavallin/HTN-2026.git zephyr
cd zephyr && pnpm install && pnpm typecheck && pnpm test
```

Update the skills later with `cd skills && git pull && ./scripts/install-skills.sh`
and open a new Claude Code session.

## Run it

Open Claude Code **in the zephyr folder** (`claude`) and type:

```
/meta-orchestrator C:\path\to\zephyr
```

It asks one batch of questions first. Answer:

| Question | Answer |
|---|---|
| Stray branches / worktrees | leave them |
| Who answers interview questions while you're away | the verifier, from `skilleddocs/decisions.md` |
| Out-of-scope issues | none (Phase 0 first, it knows) |
| Merge style | merge commit |
| Reports folder | `skilleddocs/reports/` |
| Execution mode / handoff budget | `pair` / `10` |

Then leave it. It prints two lines per merge. After 10 merges it writes
`skilleddocs/orchestrator/orchestrator-handoff.md` and stops; continue with:

```
/meta-orchestrator C:\path\to\zephyr resume
```

## Read what happened

```
/progress-report skilleddocs/reports
```

Writes a short Markdown report (done, what broke, decisions it made for you,
manual steps). Or read `skilleddocs/orchestrator/ledger.md` directly.

## One issue at a time instead

```
/next            # shows the top card
/pair 13         # builds issue #13 in a worktree, opens a PR when you say go
```

## Rules it follows (so you don't have to)

- Phase 0 issues (`phase:0` label) merge before anything else.
- One issue per lane at a time (`lane:A/B/C/D`); lanes never touch each
  other's files.
- Never merges red CI. Never touches live provider keys, sends, or deletions.
- Every decision it makes on your behalf is a row in `skilleddocs/decisions.md`.

Stop it any time with Ctrl+C; state is in git and `skilleddocs/`, so `resume`
picks up where it left off.
