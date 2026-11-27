# AGENTS.md

## Commit messages

Commits use [Conventional Commits](https://www.conventionalcommits.org). The
release tooling reads them: the type decides the next version, and the subject
of each `feat` and `fix` commit becomes one line in CHANGELOG.md. Write that
subject for people who use honk, in the imperative, lowercase after the colon.

| Type | Use it for | Version bump |
|---|---|---|
| `feat` | something new a user can see or do | minor |
| `fix` | a bug a user could hit | patch |
| `perf` | faster or lighter, same behavior | patch |
| `refactor`, `test`, `docs`, `chore`, `ci`, `build` | everything else | none |

A `!` after the type marks a breaking change: config keys, command names, or
flags that change or go away, such as `feat!: rename the config key theme to colors`.

Good subjects describe what the user gets:

```
feat: connect to several servers at once
fix: /join now accepts a channel key
perf: start faster with many channels in the config
```

The changelog only shows the subject, so a subject such as
`feat: add ServerPool class` tells a user nothing. Put the implementation
details in the commit body.

Make one commit per user-visible change, so each change gets its own changelog
line. Tests, docs, and refactors that belong to a change go in that change's
commit.

When one commit holds several user-visible changes, add one more Conventional
Commit message per change at the bottom of the body, each after a blank line.
Each one becomes its own changelog line:

```
feat: run omnibox actions on any server, not only the active one

"+ Join #x" and "Message nick" rows show for each connected server.

feat: rank omnibox matches like fzf and highlight the matched letters

feat: rank the omnibox actions you used last first
```

release-please reads every body line that starts with `word: ` as one more
message, even inside a paragraph. Wrap body text so that only the extra
messages start that way: "A second word picks the server: #rust beta" must
not wrap right before "server:".

A pull request is squash merged: its title becomes the commit subject, and its
description becomes the commit body. So the title follows the rules above, the
extra messages go at the bottom of the description, and the description is
wrapped the same way. Any description line that starts with `feat: `, `fix: `
or `perf: ` is a changelog line.

CI checks the subjects, and so does the pre-push hook (see below).

## How to work

Each change that gets a changelog line (`feat`, `fix`, `perf`) goes on its
own short-lived branch and lands through a pull request. The squash merge
turns the branch into one commit made of the pull request's title and
description, so commits on the branch can say anything, such as `wip`.

```
git switch -c join-key
# work and commit
git push -u origin join-key
gh pr create --title "fix: /join now accepts a channel key" --body-file pr.md
```

Pass the description with `--body` or `--body-file`. `--fill` copies the
branch's commit messages into it, and from there into the commit on main.

A pull request merges only after `Typecheck and build` and
`Check commit messages` pass. The user reviews it and then merges it, or runs
`gh pr merge <number> --squash --auto` so that GitHub merges it once the checks
pass.

`docs`, `chore`, and `ci` changes may go straight to main.

Run `git config core.hooksPath scripts/hooks` once in each clone. Then
`scripts/hooks/pre-push` runs the typecheck and the tests before every push,
and checks the commit subjects of a push to main.

When several agents work at the same time, each one works in its own git
worktree, so no agent sees another agent's half-done edits:

```
git worktree add ../honk-join-key -b join-key
cd ../honk-join-key && bun install
```

The tests start fakeircd on a free port. A manual `bun run fakeircd` takes
`--port N` and also uses port N+1, so give each worktree its own port.

## Releases

release-please owns the `version` in package.json, the git tags, and
CHANGELOG.md. It keeps a release PR open; the user merges it to release.
Changes go in commit messages, which release-please turns into the changelog.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for agustingianni/honk, used through the `gh`
CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
