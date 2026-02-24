# Google Contacts Share

Bidirectional sync of contacts labelled **"share"** between two Google accounts, using Google Apps Script and a Google Sheet as a sync buffer.

---

## Overview

Any contact tagged with the "share" label in either Google account is automatically copied to the other account on a 15-minute schedule. When a contact is pulled from the other account, the script first checks for a match: if any email address AND the full display name both match an existing contact, the data is merged into that record. Array fields (phone numbers, addresses, etc.) are appended; scalar fields (name, birthday, etc.) are overwritten by the incoming value. If no match is found, a new contact is created. Any remaining duplicates can be consolidated using Google Contacts' built-in merge feature. A single script is deployed identically to both accounts; it detects which account it's running in at runtime.

---

## How It Works

1. Each account runs the same script on a 15-minute trigger
2. On each run, the script acquires a lock to prevent both accounts writing to the Sheet simultaneously
3. The script reads all contacts labelled "share" and writes them to the shared Sheet (push)
4. It then reads any rows written by the *other* account that haven't been imported yet, and creates or merges them into this account (pull)
5. Processed rows are marked so they are never processed again
6. If logging is enabled, a summary of each sync run is written to a log tab in the same Sheet

---

## Requirements

- Two Google accounts (Gmail)
- A Google Sheet accessible by both accounts (one creates it, shares with the other as Editor)
- Apps Script enabled in both accounts (no installation needed — it's built into Google)
- Google People API enabled in both Apps Script projects (via **Services** → **People API v1**) — this is the one step that cannot be automated

---

## Synced Fields

All writable fields supported by the Google People API are synced:

names, nicknames, email addresses, phone numbers, addresses, organisations, birthdays, biographies, URLs, relations, events, IM clients, occupations, interests, locales, locations, miscellaneous keywords, genders, user-defined fields.

> **Note:** Profile photos are not included. The People API requires a separate endpoint to update photos and is not covered by this script.

---

## Deployment

### 1. Create the shared Sheet

In Account 1, create a new Google Sheet (name it anything, e.g. "Contact Sync"). Share it with Account 2 with **Editor** access. Copy the Sheet ID from the URL:

```
https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID_HERE/edit
```

The script will automatically create the required tabs (`contacts` and `log`) on first run. Do not create columns manually.

### 2. Set up Apps Script — repeat for both accounts

1. Go to [script.google.com](https://script.google.com) while signed into the account
2. Create a new project
3. Paste the contents of `contacts-share.gs` into the editor
4. Fill in the config at the top:
   ```javascript
   var SHEET_ID = 'YOUR_SHEET_ID_HERE';
   var ACCOUNT_EMAILS = ['account1@gmail.com', 'account2@gmail.com'];
   ```
5. Click **+** next to **Services**, find **Google People API**, select **v1**, and add it — this is the only step that cannot be automated
6. Save the script — `onOpen()` fires automatically, installs the 15-minute trigger, and runs the initial sync, prompting for OAuth consent along the way

That's it. No need to run any functions manually.

---

## Configuration Options

All options are set at the top of the script.

| Option | Default | Description |
|---|---|---|
| `SHEET_ID` | *(required)* | ID of the shared Google Sheet |
| `ACCOUNT_EMAILS` | *(required)* | Array of both account email addresses |
| `LABEL_NAME` | `share` | The Google Contacts label to sync |
| `LOGGING_ENABLED` | `true` | Whether to write sync summaries to the log tab |
| `LOG_MAX_ROWS` | `100` | Maximum number of log rows to retain before trimming |
| `LOG_MAX_ERROR_LENGTH` | `1000` | Maximum characters written to the errors column in the log |
| `LOCK_TIMEOUT_MS` | `30000` | Milliseconds to wait for a write lock before aborting (default 30 seconds) |

---

## Logging

When `LOGGING_ENABLED` is `true`, each sync run appends a row to the `log` tab in the shared Sheet. Because both accounts write to the same Sheet, all activity from both accounts appears in a single combined log in chronological order.

| Column | Description |
|---|---|
| timestamp | ISO 8601 date and time of the sync run |
| account | Email address of the account that ran the sync |
| direction | `push` (this account → Sheet), `pull` (Sheet → this account), or `sync` (lock failure) |
| pushed | Number of contacts written to the Sheet |
| new | Number of new contacts created in this account |
| merged | Number of existing contacts merged with incoming data |
| failed | Number of operations that failed |
| errors | Error details, if any |

The log is automatically trimmed to `LOG_MAX_ROWS` so it doesn't grow indefinitely. Set `LOGGING_ENABLED = false` in the config to disable logging entirely.

---

## Privacy

This script processes personal contact data including names, email addresses, and phone numbers. The following applies to how that data is handled:

- **Data stays within your Google ecosystem** — contact data is only ever written to the shared Google Sheet and to your Google Contacts. Nothing is sent to any external server or third party.
- **The Sheet is private to both accounts** — only the two accounts explicitly shared on the Sheet can access it. No one else can read or write the contact data stored there.
- **The script runs on Google's infrastructure** — all execution happens within Google Apps Script. No external compute or storage is involved.
- **You are in control** — you can revoke access, delete the Sheet, or stop the script at any time. Revoking script permissions is done via [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

---

## Limits

| Limit | Detail |
|---|---|
| Apps Script daily execution time | 6 min/run, 90 min/day (free) — far more than needed for typical contact lists |
| People API batch size | 200 contacts per read request — handled automatically |
| People API write operations | Individual write calls are used per contact. For very large contact lists (500+) this may approach API rate limits (~90 writes/minute). Batch write methods exist in the API but are not currently exposed in the Apps Script People API service |
| Contacts per "share" group | 1,000 (hardcoded in `maxMembers`) — increase if needed |
| Sync frequency | Every 15 minutes — adjustable in `createTrigger()` |
| Concurrent writes | Prevented by LockService — if a lock cannot be acquired within `LOCK_TIMEOUT_MS` the sync is skipped and logged |
| Photo sync | Not supported |
| Contacts with no name and no email | Cannot be reliably fingerprinted; may be re-pushed to the Sheet on each sync |
| Contacts with no email address | Cannot be matched for merging; will always be created as a new record |

---

## Troubleshooting

- **"Running as X which is not in ACCOUNT_EMAILS"** — the email in the script config doesn't match the account running the script. Check `ACCOUNT_EMAILS`.
- **Contacts not appearing** — confirm the "share" label exists and has contacts in Google Contacts, and that the People API is enabled in the Apps Script project.
- **Duplicate contacts building up** — expected behaviour for contacts that exist in both accounts before first sync. Use Google Contacts → **Merge & fix** to consolidate.
- **"Could not acquire lock"** in the log — both accounts attempted to sync at exactly the same time. The second one backed off and will retry on the next trigger cycle (within 15 minutes). No action needed.
- **Upgrading from v1.0.0** — existing Sheet rows have no status value in column D and will be reprocessed on first run. To prevent this, open the `contacts` tab in the Sheet, select all data rows (not the header), and set column D to `imported` before running the updated script.

---

## Contributing

Issues and pull requests are welcome.

---

## Files

- `contacts-share.gs` — the Apps Script (deploy identically to both accounts)
- `README.md` — this file
