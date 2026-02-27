# Development Notes

This document captures the architecture, design decisions, bugs fixed, and known
edge cases for Google Contacts Share. It is intended to provide full context when
continuing development.

---

## Architecture

A single Apps Script file (`contacts-share.gs`) is deployed identically to both
Google accounts. It detects which account it is running in via
`Session.getActiveUser().getEmail()` and behaves accordingly.

A shared Google Sheet acts as the sync buffer. It has two tabs:

**`contacts` tab** — five columns:
| Column | Name | Description |
|---|---|---|
| A | fingerprint | Stable identifier for the row: `account:email:value`, `account:name:value`, or `account:rn:resourceName` |
| B | source | Email of the account that wrote this row |
| C | data | Full contact data as a JSON blob (all writable People API fields, metadata stripped) |
| D | status | Blank = not yet imported by the other account. `imported` = processed |
| E | hash | Normalised hash of the contact data for change detection (see Hashing section) |

**`log` tab** — one row per sync run, written by both accounts:
`timestamp | account | direction | pushed | new | merged | failed | errors`

---

## Sync Flow

Each sync run calls `pullFromSheet` then `pushToSheet` (pull first — see below).

**Pull:**
1. Read all rows from the Sheet written by the OTHER account with blank status
2. For each row, attempt to find a matching contact in this account
3. If matched: merge the incoming data into the existing contact
4. If not matched: create a new contact
5. Mark the row `imported` regardless of success

**Push:**
1. Read all "share"-labelled contacts from this account
2. Build `receivedHashSet` — a set of hashes from all rows written by the other account with status `imported`
3. For each contact:
   - If its hash is in `receivedHashSet` → skip (it came from the other account, unchanged)
   - If its hash matches the stored hash in its own Sheet row → skip (unchanged)
   - If its hash differs → write to Sheet with blank status (changed, other account should re-pull)
   - If no row exists yet → append new row

**Why pull runs before push:**
When a contact is received from the other account and created locally, it
immediately gets the "share" label (via `addToShareGroup`). If push ran first,
that new contact would be pushed back to the Sheet before its row was marked
`imported` — so it wouldn't yet be in `receivedHashSet` — causing it to be
pushed back to the account it came from. Running pull first ensures all newly
received rows are marked `imported` before the hash set is built.

---

## Matching

Contacts are matched for merge (not create) when:

**Primary match:** any email on the incoming contact matches any email on an
existing contact (any-to-any), AND the full display name matches
(case-insensitive). Both conditions required to prevent false matches from shared
family emails or common names.

**Fallback match:** if the incoming contact has no email address at all, match
by display name alone. This handles business/service contacts (e.g. "Airportcarz")
that have no associated email.

---

## Hashing

The hash is used for two purposes:
1. Detecting whether a contact has changed since it was last pushed
2. Identifying contacts that originated from the other account (skip logic)

The hash is computed from a **normalised** contact body. Normalisation strips
API-derived fields that Google adds automatically and that differ between accounts
or between API calls, so the hash reflects only user-set data:

- Stripped from all field items: `formattedType`, `canonicalForm`
- Stripped from `names` items only: `displayName`, `displayNameLastFirst`, `unstructuredName`

The hash uses `stableHash(normaliseForHash(body))` where `stableHash` serializes
the object with keys sorted alphabetically and array items sorted by their
serialized representation (`stableStringify`), then runs a simple 32-bit hash
over the result. This ensures the same contact data always produces the same hash
regardless of field or array item ordering between API responses.

---

## Merge Behaviour

**Array fields** (emailAddresses, phoneNumbers, addresses, urls, relations,
events, imClients, miscKeywords, userDefined): incoming items are appended to
existing items, deduplicated by the item's `value` / `formattedValue` /
`canonicalForm` field rather than full JSON. Full JSON deduplication failed
because the same phone number can have slightly different surrounding metadata
between accounts.

**Scalar fields** (names, nicknames, organizations, birthdays, biographies,
occupations, interests, locales, locations, genders): incoming value wins if
non-empty, otherwise existing value is kept.

**etag:** the contact is re-fetched immediately before `updateContact` to get a
guaranteed fresh etag. Using the etag from the initial index fetch caused
"resource exhausted" API errors when the contact had been modified between
indexing and the update call.

---

## Bugs Fixed (version history)

**v1.1.0**
- Stale etag on merge caused "resource exhausted" API errors → re-fetch etag immediately before update
- Pushed rows had status reset to blank on every push → preserve existing status when hash unchanged
- Email addresses accumulated on each merge → deduplicate array fields by value
- Log entries exceeded Sheets 50,000 character cell limit → truncate to LOG_MAX_ERROR_LENGTH
- Added LockService to prevent concurrent writes from both accounts
- Added sync logging to Sheet log tab
- Added debugSheet() utility

**v1.2.0**
- Hash-based change detection added (column E in Sheet)
- Skip logic added: contacts received from other account not pushed back if unchanged
- stableHash / stableStringify introduced for field-order-independent hashing

**v1.3.0**
- normaliseForHash introduced: strips API-derived fields (formattedType, canonicalForm,
  displayName, displayNameLastFirst, unstructuredName) before hashing so hash is
  stable across API round-trips and accounts
- stableStringify extended to sort array items as well as object keys
- Skip logic simplified from key-based lookup to hash set (receivedHashSet) —
  works for all contacts regardless of whether they have an email address

**v1.4.0**
- Pull runs before push in syncContacts — fixes contacts being pushed back to
  originating account on the first run after being received
- Name-only fallback matching in findExactMatch for contacts with no email
- byName index added to getAllContactsIndexed to support name-only matching
- "Pushed (unchanged)" removed — unchanged contacts are now skipped entirely
  rather than written to the Sheet with identical data

**v1.4.1**
- Label/type changes on email addresses and phone numbers not propagating to
  the receiving account. Root cause: array field deduplication by value
  discarded incoming items that matched an existing value, even when type or
  label had changed. Fixed by replacing the filter/dedup approach in
  mergeContactBody with a two-pass map: existing items loaded first, incoming
  items applied on top, so updated items correctly replace existing ones rather
  than being discarded. Also correctly handles setting a label for the first
  time on a previously unlabelled field.

---

## Known Limitations

- **Photos** — not synced. The People API requires a separate `updateContactPhoto`
  endpoint not exposed in Apps Script's People service.
- **Deletion sync** — not implemented. Detecting and propagating deletions requires
  tracking resource names over time and risks accidental data loss. Intentionally
  out of scope.
- **Contacts with no name and no email** — cannot be reliably fingerprinted and
  may be re-pushed on each sync.
- **Contacts with no email** — cannot be matched for merge using the primary
  (email+name) path. Name-only fallback is used. If two contacts in the same
  account share an identical display name with no email, only the first indexed
  will be matched.
- **Large contact lists** — individual write API calls are used per contact
  (~90/minute limit). Batch write methods exist in the People API but are not
  exposed in the Apps Script People service.
- **Concurrent writes** — prevented by LockService. If both accounts attempt to
  sync simultaneously, the second waits up to LOCK_TIMEOUT_MS then aborts and
  retries on the next trigger cycle.

---

## Upgrading Between Versions

When upgrading from any previous version, clear all data rows from the `contacts`
Sheet tab (keep the header row) and let both accounts re-push fresh. This
ensures hashes are recomputed with the current normalisation logic. The first
run after clearing will push all contacts and the other account will pull them —
this is a one-time operation.

If the Sheet is missing the `hash` header in column E, add it manually to cell E1.

---

## Repository Files

| File | Description |
|---|---|
| `contacts-share.gs` | The Apps Script — deploy identically to both accounts |
| `README.md` | User-facing setup and usage documentation |
| `DEVELOPMENT.md` | This file — architecture and development history |
| `CONTRIBUTING.md` | Contribution guidelines and testing checklist |
| `SECURITY.md` | Security policy and vulnerability reporting |
| `LICENSE` | GNU GPL v3 |
