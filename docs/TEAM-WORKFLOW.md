# Team workflow: board, lanes, skills

## The board

https://github.com/users/KrishP147/projects/4 — one card per issue in this
repo. Columns: Todo → In Progress → Done. Labels on every card:

| Label | Meaning |
|---|---|
| `lane:A` runtime · `lane:B` policy · `lane:C` tools · `lane:D` platform | who owns which files; see "Four parallel lanes" in `docs/backend-extension-plan.md` |
| `phase:0` … `phase:5` | order. **Phase 0 merges before anything else.** |
| `size:S/M/L` | ≤ half day / 1–3 days / a week+ |
| `status:todo/in-progress/done` | mirror of the column for tools that can't read the board |

Pick a lane (one person per lane), take the lowest-phase Todo card in it,
move it to In Progress. Two people never work the same lane at once; four
lanes run in parallel without touching the same files. An issue body's
"Depends on: #n" must be merged first.

Where things are:

- Plan: `docs/backend-extension-plan.md` (phases, lanes, issue map)
- Why we decided things: `skilleddocs/decisions.md` (cite `D<k>` in PRs)
- Session handoffs, orchestrator ledger, reports: `skilleddocs/`

## Doing an issue by hand

```bash
git switch -c <you>/issue-<n>-<slug> main
# build it; small commits
pnpm typecheck && pnpm test && pnpm build
gh pr create --fill          # "Closes #<n>" in the body
```

Merge commit into `main` when CI is green, delete the branch, move the card
to Done.

## Doing it with Krish's skills (optional, faster)

Skills are prompts Claude Code loads; agents are workers it spawns. Install
once, globally:

```bash
npm i -g @anthropic-ai/claude-code          # if you don't have it
gh auth refresh -s project -s read:project  # board access
git clone https://github.com/KrishP147/skills.git
cd skills && ./scripts/install-skills.sh    # Windows: .\scripts\install-skills.ps1
```

Then in Claude Code inside this repo:

| Type | What happens |
|---|---|
| `/next` | shows the top Todo card(s) for you to pick |
| `/pair 13` | a manager agent + implementer build #13 in a worktree, run the tests, and open the PR when you say go. You review and merge. |
| `/session-handoff 13` | when you stop mid-issue: writes `skilleddocs/handoffs/…`, moves the card |
| `/update-progress` | fresh session after a handoff: verifies claims, updates docs + board |
| `/consult-plan <idea>` | pitch a deviation; result lands in `skilleddocs/decisions.md` |
| `/grill-docs <doc>` | stress-test a plan with a recorded transcript |

Update skills: `cd skills && git pull && ./scripts/install-skills.sh`, then
a new Claude session.

Full unattended mode (planner → manager → merge gate → verifier over the whole
board) is `/meta-orchestrator`; see `docs/ORCHESTRATOR-GUIDE.md`. Only one
person runs that at a time.

## Ground rules

- Never commit `.env` or credentials. Mock mode runs everything with no keys.
- Don't relax a safety invariant for convenience (see `AGENTS.md`).
- A PR touching another lane's files needs that lane owner's review.
- Docs drift is a bug: a merged feature the README doesn't mention gets fixed
  in the same PR.
