# Contributing

Guidelines
- Fork the repo and create feature branches named `feat/<short-desc>` or `fix/<short-desc>`.
- Keep changes focused and make small, testable commits.
- Follow the existing style: Prettier config and `.editorconfig` (2-space indentation).

Pull request checklist
- Update or add tests for new logic (prefer unit tests for pure functions).
- Run `npx prettier --write` and `npx eslint --fix` on changed files.
- Ensure no credentials are included and `.env` is not committed.
- Describe the change and why in the PR description; link any issue if applicable.

Issue reporting
- Include steps to reproduce, expected vs actual behavior, and environment details (Node version).

Code review
- Reviewers should validate that the change is minimal and does not expose credentials or leak tokens.
