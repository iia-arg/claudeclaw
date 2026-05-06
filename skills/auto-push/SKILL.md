---
name: auto-push
description: Push committed work in tracked git repos to GitHub on request. Use when the user asks to "push", "sync to github", "send to remote", "выгрузи на гитхаб", "запушь", or similar. NEVER auto-commits — if the working tree is dirty, surface it instead.
---

# auto-push

Soft-policy GitHub push for the tracked repos on this host.

## When to use

User says any of:
- "push everything", "push to github", "sync to github"
- "выгрузи", "запушь", "отправь на гитхаб"
- Names a specific repo and asks to push it

Don't use for:
- A first commit on a new branch the user hasn't asked to publish.
- Force pushes, branch deletions, or anything destructive.
- main/master of an upstream-owned repo (e.g. `sbusso/claudeclaw`).

## What to do

1. **Run the existing host script first.** It encodes the agreed
   policy (no auto-commit, rebase-on-divergence, no force-push):

   ```bash
   /home/claude/aclaude-host-config/scripts/auto-push.sh
   ```

   Or, equivalently, trigger the systemd unit:

   ```bash
   sudo systemctl start auto-push.service
   journalctl -u auto-push.service -n 30 --no-pager
   ```

   The same job runs automatically every Sunday at 20:00 MSK via
   `auto-push.timer`.

2. **Read the result.** Per repo, the script logs one of:

   | Tag | Meaning | Action |
   | --- | --- | --- |
   | `OK` | pushed N commits | report what landed |
   | `NOOP` | already up to date OR behind upstream | nothing to do |
   | `SKIP` | working tree dirty, detached HEAD, or not a git repo | tell the user what's blocking; do NOT auto-commit |
   | `REBASE` | branch ahead AND behind, ran `pull --rebase` | report the rebase |
   | `WARN` / `FAIL` | fetch/push/rebase error | show the journal tail; never retry with `--force` |

3. **Report concisely.** One line per repo, leaning on the tags above.

## What NOT to do

- **Never** call `git commit -a`, `git add -A && git commit`, or
  anything that materializes a commit without the user's explicit
  per-commit approval. The whole point of the soft policy is to keep
  authorship human.
- **Never** `git push --force` or `--force-with-lease`. If a push is
  rejected after `pull --rebase`, surface the failure instead.
- **Never** push to a branch whose upstream is on a repo you don't
  own (e.g. `upstream/main` on `sbusso/claudeclaw`). The script only
  pushes to `origin`, which is fine.

## Tracked repos

The list is the `REPOS` array at the top of
`/home/claude/aclaude-host-config/scripts/auto-push.sh`. As of writing:

- `~/aclaude-host-config`
- `~/my-assistant/claudeclaw`

To add a repo: edit that array, commit & push the host-config repo,
then `sudo /home/claude/aclaude-host-config/apply.sh`.

## Manual one-off push

If the user asks to push a single repo only, prefer:

```bash
cd <repo>
git push origin "$(git rev-parse --abbrev-ref HEAD)"
```

This is what the script would do anyway, just scoped.
