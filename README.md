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