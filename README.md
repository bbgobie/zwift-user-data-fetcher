# Zwift User Data Extractor

This project allows you to extract user data from Zwift and optionally upload it to Google Sheets. It processes Zwift user IDs to generate CSV files with user information.

## Prerequisites

- **Node.js**: You need Node.js installed on your computer. If you don't have it, download and install it from [nodejs.org](https://nodejs.org/). Choose the LTS (Long Term Support) version for stability.
  - On macOS, you can also install it using Homebrew: `brew install node`.
- Basic knowledge of using a terminal/command line.

## Installation

1. Clone or download this repository to your computer.
2. Open a terminal and navigate to the project folder (e.g., `cd /path/to/GetUserData`).
3. Install the required dependencies by running:
   ```
   npm install
   ```
   This will install packages like `googleapis` and `csv-parse`.

## Configuration

### Environment Variables

1. Copy the example environment file: Create a file named `.env` in the project root.
2. Set the following variables in `.env`:
   - `ZWIFT_USERNAME`: Your Zwift username.
   - `ZWIFT_PASSWORD`: Your Zwift password.
   - `SPREADSHEET_ID`: The ID of your Google Sheet (from the URL, between `/d/` and `/edit`).
   - Optional: `ZWIFTPOWER_COOKIES` or `ZWIFTPOWER_COOKIE_FILE` for ZwiftPower cookies to avoid login pages.

**Security Note**: Never commit your `.env` file or cookie files to version control. Add them to `.gitignore`.

### Google Sheets Setup (Optional, for uploading data)

If you want to upload the extracted data to Google Sheets:

1. Go to the [Google Cloud Console](https://console.developers.google.com) and create or select a project.
2. Enable the **Google Sheets API** (and optionally **Google Drive API** if the script needs to create files).
3. In **IAM & Admin** → **Service Accounts**, create a new service account with the **Editor** role (or minimum required permissions).
4. Create a JSON key for the service account and download it (e.g., `google-credentials.json`).
5. Place the JSON file in the project root.
6. Set the credentials in your `.env`:
   - Either `GOOGLE_APPLICATION_CREDENTIALS=/full/path/to/google-credentials.json`
   - Or `SERVICE_ACCOUNT_KEY` with the JSON contents.
7. Create a Google Sheet, get its ID from the URL, and set `SPREADSHEET_ID`.
8. Share the spreadsheet with the service account email (looks like `...@<project>.iam.gserviceaccount.com`) and grant **Editor** access.

### ZwiftPower Cookies (Optional)

To avoid HTML login pages on ZwiftPower, provide cookies:
- Set `ZWIFTPOWER_COOKIES` with serialized cookies, or
- Point `ZWIFTPOWER_COOKIE_FILE` to `zwiftpower_cookies.json`.

## Usage

### Extracting User Data

Run the script with one or more Zwift user IDs:

```
node get-user-data.js [user_id1] [user_id2] ...
```

The script will process the IDs and generate a CSV file in the `output/` folder.

### Uploading to Google Sheets

After extracting data:

1. Ensure dependencies are installed (`npm install`).
2. Run:
   ```
   node write_to_sheets.js
   ```

## Examples

- Single user:
  ```
  node get-user-data.js 123456
  ```

- Multiple users:
  ```
  node get-user-data.js 123456 234567 345678
  ```

The program generates a single CSV file with all results in the `output/` folder.

## Additional Notes

- The CSV file will be named something like `zwift_data_[timestamp].csv`.
- If uploading to Sheets fails, check your credentials and permissions.
- For help, refer to the scripts or open an issue in the repository.
