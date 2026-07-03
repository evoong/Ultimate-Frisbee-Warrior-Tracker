---
description: Commit working tree changes on a branch and open a pull request
allowed-tools: Bash(git *), Bash(gh *)
---

Commit the current working tree changes and open a pull request. Follow these
steps exactly.

1. Inspect the state: run `git status`, `git diff`, and `git log --oneline -5`
   to understand what changed and match the repository's commit message style.

2. Pick the branch:
   - If the current branch is `main`, create a new branch from it with a short
     descriptive name (`fix/<topic>`, `feature/<topic>`, or `chore/<topic>`).
   - If already on a feature branch, stay on it.
   - Never commit to `main` directly, and never run `git push origin main`.

3. Commit:
   - Stage only files related to the change. Do not stage secrets or files
     covered by .gitignore.
   - Write a concise commit message in the imperative mood ("Add x", "Fix y"),
     with a body only when the why is not obvious from the diff.
   - Do NOT include any Co-Authored-By lines, AI attribution, emojis, or em
     dashes in the commit message.

4. Push the branch to origin with `git push -u origin <branch>`.

5. Open a pull request against `main` with `gh pr create`. The body should
   briefly cover the problem, the change, and how it was verified. Keep the
   tone plain and professional: no emojis, no em dashes, and no AI attribution
   footer.

6. Report the PR URL when done.
