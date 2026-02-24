# Google Contacts Sync

Bidirectional sync of contacts labelled **"share"** between two Google accounts, using Google Apps Script and a Google Sheet as a sync buffer.

---

## Overview

Any contact tagged with the "share" label in either Google account is automatically copied to the other account on a 15-minute schedule. When a contact is pulled from the other account, the script first checks for a match: if any email address AND the full display name both match an existing contact, the data is merged into that record. Array fields (phone numbers, addresses, etc.) are appended; scalar fields (name, birthday, etc.) are overwritten by the incoming value. If no match is found, a new contact is created. Any remaining duplicates can be consolidated using Google Contacts' built-in merge feature. A single script is deployed identically to both accounts; it detects which account it's running in at runtime.

---

## How It Works

1. Each account runs the same script on a 15-minute trigger
2. On each run, the script reads all contacts labelled "share" and writes them to a shared Google Sheet (push)
3. It then reads any rows in the Sheet written by the *other* account that haven't been imported yet, creates them as new contacts, and tags them "share" (pull)
4. Imported rows are marked so they're never processed again

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

The script will automatically create a tab named `contacts` with the required columns on first run. Do not create columns manually.

### 2. Set up Apps Script — repeat for both accounts

1. Go to [script.google.com](https://script.google.com) while signed into the account
2. Create a new project
3. Paste the contents of `sync_contacts.gs` into the editor
4. Fill in the config at the top:
   ```javascript
   var SHEET_ID = 'YOUR_SHEET_ID_HERE';
   var ACCOUNT_EMAILS = ['account1@gmail.com', 'account2@gmail.com'];
   ```
5. Click **+** next to **Services**, find **Google People API**, select **v1**, and add it — this is the only step that cannot be automated
6. Save the script — `onOpen()` fires automatically, installs the 15-minute trigger, and runs the initial sync, prompting for OAuth consent along the way

That's it. No need to run any functions manually.

---

## Limits

| Limit | Detail |
|---|---|
| Apps Script daily execution time | 6 min/run, 90 min/day (free) — far more than needed for typical contact lists |
| People API batch size | 200 contacts per request — handled automatically |
| People API write quota | ~90 writes/minute — relevant only if syncing hundreds of contacts at once |
| Contacts per "share" group | 1,000 (hardcoded in `maxMembers`) — increase if needed |
| Sync frequency | Every 15 minutes — adjustable in `createTrigger()` |
| Photo sync | Not supported |
| Contacts with no name and no email | Cannot be reliably fingerprinted; may be re-pushed to the Sheet on each sync |
| Contacts with no email address | Cannot be matched for merging; will always be created as a new record |

---

## Troubleshooting

- **"Running as X which is not in ACCOUNT_EMAILS"** — the email in the script config doesn't match the account running the script. Check `ACCOUNT_EMAILS`.
- **Contacts not appearing** — confirm the "share" label exists and has contacts in Google Contacts, and that the People API is enabled in the Apps Script project.
- **Duplicate contacts building up** — expected behaviour for contacts that exist in both accounts before first sync. Use Google Contacts → **Merge & fix** to consolidate.

---

## Files

- `sync_contacts.gs` — the Apps Script (deploy identically to both accounts)
- `README.md` — this file
