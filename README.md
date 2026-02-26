# Google Contacts Share

Bidirectionally syncs contacts between two Gmail accounts using a shared Google Sheet as a sync buffer. A single Apps Script is deployed to both accounts — it detects which account it is running in and behaves accordingly.

---

## How It Works

Each account runs the same script on a 15-minute trigger. On each run:

1. **Pull** — reads rows written by the other account that haven't been imported yet, and creates or merges those contacts into this account
2. **Push** — writes this account's "share"-labelled contacts to the Sheet, skipping contacts that are unchanged or that originated from the other account

The Sheet has two tabs: `contacts` (the sync buffer) and `log` (one row per sync run from both accounts).

---

## Requirements

- Two Google accounts (Gmail)
- One shared Google Sheet (either account can own it)
- Google Apps Script (free, built into Google)
- People API enabled in both script projects

---

## Setup

### 1. Create the shared Sheet

In either Google account, create a new Google Sheet. Copy its ID from the URL:
`https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit`

Share the Sheet with the other account (Editor access).

### 2. Set up Account 1

1. Go to [script.google.com](https://script.google.com) in Account 1
2. Create a new project, paste in the contents of `contacts-share.gs`
3. Fill in `SHEET_ID` and both `ACCOUNT_EMAILS`
4. Click **Services** → add **Google People API**
5. Save and click **Run → onOpen** to grant permissions and install the trigger

### 3. Set up Account 2

Repeat step 2 in Account 2, using the **identical** script (same `SHEET_ID`, same `ACCOUNT_EMAILS`).

### 4. Create the "share" label

In Google Contacts in each account, create a label called `share` (or whatever you set `LABEL_NAME` to). Add contacts to this label to sync them.

---

## Configuration

All configuration is at the top of the script. The only values that need changing are `SHEET_ID` and `ACCOUNT_EMAILS` — everything else has sensible defaults.

| Variable | Default | Description |
|---|---|---|
| `SHEET_ID` | _(required)_ | ID from the shared Google Sheet URL |
| `SHEET_NAME` | `contacts` | Tab name for the sync buffer |
| `LABEL_NAME` | `share` | Google Contacts label to sync |
| `ACCOUNT_EMAILS` | _(required)_ | Both account email addresses |
| `LOGGING_ENABLED` | `true` | Write sync activity to the log tab |
| `LOG_SHEET_NAME` | `log` | Tab name for the log |
| `LOG_MAX_ROWS` | `100` | Maximum log rows to retain |
| `LOG_MAX_ERROR_LENGTH` | `1000` | Maximum characters per error cell |
| `LOCK_TIMEOUT_MS` | `30000` | Max wait for Sheet lock (ms) |

---

## What Gets Synced

All standard contact fields are synced:

names, nicknames, email addresses (including labels), phone numbers (including labels), postal addresses, organisations, birthdays, biographies, URLs, relations, events, IM clients, occupations, interests, locales, locations, miscellaneous keywords, genders, user-defined fields.

**Not synced:** profile photos (requires a separate API endpoint not available in Apps Script), contact deletions (out of scope — see DEVELOPMENT.md).

---

## Merge Behaviour

When a contact exists in both accounts:

- **Phone numbers, emails, addresses, URLs** and other list fields are combined and deduplicated
- **Name, organisation, birthday, biography** and other single-value fields: the incoming value wins if non-empty

---

## Matching

Incoming contacts are matched to existing contacts for merge (rather than create) when:

- **Primary:** any email address matches AND the display name matches (case-insensitive)
- **Fallback:** if the contact has no email address, display name alone is used

---

## Monitoring

With `LOGGING_ENABLED = true`, the `log` tab in the shared Sheet records every sync run from both accounts with counts of pushed, created, merged, and failed contacts, plus any error messages.

The Apps Script execution log (View → Executions) shows per-contact activity: `Pushed (new)`, `Pushed (updated)`, `Skipped (unchanged)`, `Created`, `Merged`, `Skipped (unchanged, received from other account)`.

---

## Troubleshooting

**"Running as X which is not in ACCOUNT_EMAILS"**
The script is running in an account not listed in `ACCOUNT_EMAILS`. Check both accounts have identical configuration.

**"No label 'share' found"**
The `LABEL_NAME` label doesn't exist in this account's Google Contacts. Create it and add at least one contact.

**Contacts not appearing in the other account**
Check the `log` tab — look for failed rows or error messages. Check the Apps Script execution log for the other account.

**Merge failed errors**
Usually a transient API issue. The script will retry on the next trigger cycle.

**"Could not acquire lock"**
Both accounts attempted to sync at exactly the same time. The second run aborted and will retry on the next cycle. Normal behaviour.

**Duplicate contacts after upgrade**
If upgrading from a version prior to v1.2.0, clear all data rows from the `contacts` Sheet tab (keep the header row) and let both accounts re-push. Without this the hash column will be missing or stale, causing contacts to be repeatedly pushed.

### Upgrading from any previous version

Clear all data rows from the `contacts` Sheet tab (keep the header row with `fingerprint | source | data | status | hash`). Both accounts will re-push on the next run. This is a one-time operation.

If column E has no header, add `hash` to cell E1 manually.

---

## Debugging

Run `debugSheet()` manually from the Apps Script editor (Run → debugSheet) to print a summary of every row in the contacts Sheet to the execution log, including name, source, status, email count, and hash.

---

## Limitations

- Maximum ~1000 contacts in the "share" label (People API group member limit)
- Individual contact writes are rate-limited to ~90/minute. Large initial syncs (500+ contacts) may take several trigger cycles
- Contacts with no name and no email cannot be reliably fingerprinted and may cause repeated pushes
- Two contacts with identical display names and no email in the same account: only the first will be matched for merge

---

## Files

| File | Description |
|---|---|
| `contacts-share.gs` | The Apps Script — deploy identically to both accounts |
| `README.md` | This file |
| `DEVELOPMENT.md` | Architecture, design decisions, and version history |
| `CONTRIBUTING.md` | Contribution guidelines |
| `SECURITY.md` | Security policy |
| `LICENSE` | GNU GPL v3 |

---

## Licence

GNU General Public License v3.0 — see `LICENSE`.
