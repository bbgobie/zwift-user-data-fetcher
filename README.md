Usage Examples
bash# Single user
node get-user-data.js 123456

# Two users
node get-user-data.js 123456 234567

# Five users
node get-user-data.js 123456 234567 345678 456789 567890

# Ten users
node get-user-data.js 123456 234567 345678 456789 567890 678901 789012 890123 901234 012345
The program will process however many IDs you provide and generate a single CSV file with all the results in the output folder. 

Additional notes
- **Environment**: Copy `.env.example` to `.env` and set `ZWIFT_USERNAME` and `ZWIFT_PASSWORD`.
- **ZwiftPower cookies**: To avoid HTML login pages from ZwiftPower, provide a serialized cookie jar via `ZWIFTPOWER_COOKIES` or point to `zwiftpower_cookies.json` with `ZWIFTPOWER_COOKIE_FILE`.
- **Security**: Never commit your real `.env` or cookie files to version control.

Google Sheets / Service Account Setup
1. Go to https://console.developers.google.com and create or select a project.
2. Enable the following APIs: **Google Sheets API** (and optionally **Google Drive API** if you want the script to create files).
3. In IAM & Admin → Service Accounts, create a new service account and give it the role **Editor** (or at minimum the Sheets/Drive permissions you need).
4. Create a JSON key for the service account and download it. This file is your credentials JSON.
5. Place the JSON file locally (for example: `google-credentials.json`) and set one of these environment variables:
	- `GOOGLE_APPLICATION_CREDENTIALS=/full/path/to/google-credentials.json` or
	- `SERVICE_ACCOUNT_KEY` — copy the JSON contents into this env var.
6. Create a Google Sheet. Grab its ID from the URL (the long id between `/d/` and `/edit`) and set `SPREADSHEET_ID` in your `.env` or environment.
7. Share the spreadsheet with the service account email (the address looks like `...@<project>.iam.gserviceaccount.com`) — grant Editor or at least Editor on the sheet so the service account can write and change formatting.

Running the uploader
1. Ensure `googleapis` and `csv-parse` are installed (`npm install`).
2. Export credentials and run:

```bash
google-credentials.json
node write_to_sheets.js
```