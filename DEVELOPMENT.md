# Development Guide

Quick start
1. Install dependencies:

```bash
npm install
```

2. Create a `.env` at the project root with your Zwift credentials:

```bash
cat > .env <<EOF
ZWIFT_USERNAME=you@example.com
ZWIFT_PASSWORD=your_password
EOF
```

3. Run the script for one or more user IDs:

```bash
node get-user-data.js 12345 23456
```

Notes and troubleshooting
- Ensure Node version is >=16.14.0 per `package.json` `engines` field.
- If authentication fails, check `.env` values and that your account supports API access.

Output
- CSV files are written to the `output/` folder. The program will create the folder if it doesn't exist.

Formatting and linting
- The project includes `.prettierrc` and `.eslintrc.json`. Use these tools to format and lint changes:

```bash
npx prettier --write "**/*.js"
npx eslint --fix "**/*.js"
```

Recommended dev dependencies (optional)
- `eslint`, `prettier`, `jest` for tests. To add them:

```bash
npm install -D eslint prettier jest
```
