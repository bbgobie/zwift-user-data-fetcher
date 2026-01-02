# Copilot Guide for this Repo

Purpose
- Short: help Copilot make useful, safe suggestions for this small Node.js project that fetches Zwift user power profiles and exports CSV files.

Key files
- `get-user-data.js`: main script that authenticates with Zwift, fetches profiles, extracts power segments, and writes CSV to `output/`.
- `package.json`: project metadata and `engines.node` requirement. Note: scripts reference `zwift-fetcher.js` but the repo currently uses `get-user-data.js`.

Environment
- Required env vars (create a `.env` file in the project root):

```
ZWIFT_USERNAME=your_email@example.com
ZWIFT_PASSWORD=your_password
```

How to run (basic)
```
npm install
node get-user-data.js 12345 23456
```

Coding style & constraints for suggestions
- Follow Prettier (.prettierrc) and the existing `.editorconfig` (2 spaces, LF, utf-8).
- Keep Node compatibility >= 16.14.0 (project `engines.node`).
- Use `async/await` already used in the codebase; prefer small focused changes.
- Do not commit `.env` or credentials.

Common improvement tasks Copilot can help with
- Add retry/backoff for network calls and improve error messages.
- Add unit tests for pure functions (e.g., `extractPowerFromSegments`) — keep tests lightweight and dependency-free.
- Add CLI argument validation and helpful error messages.

Example prompts for Copilot
- "Refactor `extractPowerFromSegments` to be more testable and add a Jest unit test for three durations."
- "Add an env-check helper that validates `ZWIFT_USERNAME` and `ZWIFT_PASSWORD` early with clear instructions, and write tests for it."

Commit message guidance
- Use present-tense imperative style: "Fix", "Add", "Refactor".
- Mention the file(s) changed and the short rationale.

Notes to reviewers
- Check for accidental credential leakage and that `output/` remains in `.gitignore` (not present in repo — consider adding if needed).
