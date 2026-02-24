/**
 * Google Contacts Share
 * Bidirectionally syncs contacts labelled "share" between two Gmail accounts.
 * https://github.com/sjc200/google-contacts-share
 *
 * A single script is deployed identically to both accounts. It detects which
 * account it is running in at runtime and behaves accordingly, using a shared
 * Google Sheet as a sync buffer.
 *
 * Setup: see README.md
 *
 * @author sjc200
 * @licence MIT
 */

// ============================================================
// CONFIGURATION — same in both accounts, no changes needed
// except SHEET_ID and ACCOUNT_EMAILS
// ============================================================
var SHEET_ID = 'YOUR_SHEET_ID_HERE';          // ID from the shared Google Sheet URL
var SHEET_NAME = 'contacts';                   // Tab name — created automatically on first run
var LABEL_NAME = 'share';                      // Google Contacts label to sync
var ACCOUNT_EMAILS = ['account1@gmail.com', 'account2@gmail.com']; // Both accounts

var LOGGING_ENABLED = true;                    // Set to false to disable logging to the log sheet
var LOG_SHEET_NAME = 'log';                    // Tab name for the log — created automatically
var LOG_MAX_ROWS = 100;                        // Maximum number of log rows to retain

var LOCK_TIMEOUT_MS = 30000;                   // Max milliseconds to wait for a Sheet lock (30 seconds)

// ============================================================
// PEOPLE API FIELDS
// All writable fields supported by the Google People API.
// PERSON_FIELDS is used for read requests; UPDATE_FIELDS for
// updateContact calls. Both must stay in sync.
// Note: batch write methods (batchCreateContacts,
// batchUpdateContacts) are not currently exposed in the Apps
// Script People API service. Individual write calls are used
// instead. For very large contact lists (500+) this may
// approach API rate limits — see README for details.
// ============================================================
var PERSON_FIELDS = [
  'names', 'nicknames', 'emailAddresses', 'phoneNumbers',
  'addresses', 'organizations', 'birthdays', 'biographies',
  'urls', 'relations', 'events', 'imClients', 'occupations',
  'interests', 'locales', 'locations', 'miscKeywords',
  'genders', 'userDefined'
].join(',');

var UPDATE_FIELDS = PERSON_FIELDS;

// ============================================================
// AUTO SETUP — fires when script is opened
// Checks whether a time-based trigger already exists for
// syncContacts, installs one if not, then runs an initial sync.
// This means the user only needs to open the script once —
// no manual function calls required.
// ============================================================
function onOpen() {
  var triggers = ScriptApp.getProjectTriggers();
  var exists = triggers.some(function(t) {
    return t.getHandlerFunction() === 'syncContacts';
  });
  if (!exists) createTrigger();
  syncContacts();
}

// ============================================================
// TRIGGER SETUP
// Creates a time-based trigger to run syncContacts every 15
// minutes. Only called once by onOpen if no trigger exists.
// To change sync frequency, adjust everyMinutes() below.
// ============================================================
function createTrigger() {
  ScriptApp.newTrigger('syncContacts')
    .timeBased()
    .everyMinutes(15)
    .create();
}

// ============================================================
// IDENTITY
// Detects which Google account the script is running in by
// reading the active user's email. Throws a clear error if
// the account isn't in ACCOUNT_EMAILS, so misconfigurations
// are caught immediately rather than silently misbehaving.
// ============================================================

/**
 * Returns the email address of the currently active account,
 * normalised to lowercase.
 * @return {string}
 */
function getMyEmail() {
  return Session.getActiveUser().getEmail().toLowerCase();
}

/**
 * Validates that the current account is one of the two configured
 * accounts. Throws an error if not.
 * @return {string} The current account's email address.
 */
function validateAccount() {
  var me = getMyEmail();
  if (ACCOUNT_EMAILS.map(function(e){ return e.toLowerCase(); }).indexOf(me) === -1) {
    throw new Error('Running as ' + me + ' which is not in ACCOUNT_EMAILS. Check your config.');
  }
  return me;
}

// ============================================================
// MAIN ENTRY POINT
// Validates the account, then runs push followed by pull.
// Push writes this account's "share" contacts to the Sheet.
// Pull reads the other account's contacts from the Sheet and
// creates or merges them into this account.
// A script lock is acquired before any Sheet writes to prevent
// concurrent writes from both accounts corrupting data. If the
// lock cannot be acquired within LOCK_TIMEOUT_MS, the sync is
// aborted and an error is logged.
// ============================================================
function syncContacts() {
  var me = validateAccount();

  // Acquire a script-wide lock before touching the Sheet.
  // LockService.getScriptLock() is shared across all instances
  // of this script — i.e. both accounts — so only one can write
  // to the Sheet at a time.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
  } catch(e) {
    var msg = 'Could not acquire lock within ' + (LOCK_TIMEOUT_MS / 1000) + 's — another sync may be running. Aborting.';
    Logger.log(msg);
    writeLog(me, 'sync', 0, 0, 0, 1, msg);
    return;
  }

  try {
    pushToSheet(me);
    pullFromSheet(me);
  } finally {
    // Always release the lock, even if an error occurs
    lock.releaseLock();
  }
}

// ============================================================
// PUSH
// Reads all contacts in this account labelled "share" and
// writes them to the shared Sheet. Each contact is stored as
// a JSON blob in a single cell, with a fingerprint used to
// identify the row on subsequent runs (to update rather than
// append a duplicate row).
// ============================================================

/**
 * Reads "share"-labelled contacts from this account and upserts
 * them into the shared Sheet. Existing rows are updated in place;
 * new contacts are appended.
 * @param {string} me - The current account's email address.
 */
function pushToSheet(me) {
  var contacts = getShareContacts();
  var pushed = 0;

  if (!contacts.length) {
    writeLog(me, 'push', 0, 0, 0, 0, 'No contacts found in "' + LABEL_NAME + '" label');
    return;
  }

  var sheet = getOrCreateSheet();
  var existingData = sheet.getDataRange().getValues();

  // Build an index of existing fingerprints → row number so we
  // can update rows in place rather than appending duplicates
  var fingerprintIndex = {};
  for (var i = 1; i < existingData.length; i++) {
    fingerprintIndex[existingData[i][0]] = i + 1; // 1-based row number
  }

  contacts.forEach(function(person) {
    var fp = fingerprint(person, me);
    var row = serializeContact(person, me, fp);
    if (fingerprintIndex[fp]) {
      sheet.getRange(fingerprintIndex[fp], 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    pushed++;
  });

  writeLog(me, 'push', pushed, 0, 0, 0, '');
}

// ============================================================
// PULL
// Reads rows in the shared Sheet that were written by the OTHER
// account and haven't been imported yet (status column is blank).
// For each row, attempts to find a matching contact in this
// account by checking if any email address AND the full display
// name both match. If a match is found, the contact data is
// merged. If not, a new contact is created.
// Once processed, the row is marked "imported" so it is never
// processed again.
// ============================================================

/**
 * Reads unprocessed rows from the other account in the shared Sheet
 * and either merges them into an existing contact or creates a new one.
 * @param {string} me - The current account's email address.
 */
function pullFromSheet(me) {
  var sheet = getOrCreateSheet();
  var data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    writeLog(me, 'pull', 0, 0, 0, 0, 'No rows in sheet');
    return;
  }

  // Index all contacts in this account by every email address
  // they have, for use in match lookups
  var indexed = getAllContactsIndexed();

  var newCount = 0;
  var mergedCount = 0;
  var failedCount = 0;
  var errors = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var source = row[1];
    var status = row[3];

    // Skip rows written by this account — only process the other account's rows
    if (source.toLowerCase() === me) continue;
    // Skip rows already imported
    if (status === 'imported') continue;

    var person = deserializeContact(row);
    if (!person) {
      failedCount++;
      errors.push('Row ' + (i + 1) + ': failed to deserialize');
      continue;
    }

    var match = findExactMatch(person, indexed);
    if (match) {
      // Merge incoming data into the existing contact
      var body = mergeContactBody(buildContactBody(match), buildContactBody(person));
      body.etag = match.etag;
      try {
        People.People.updateContact(body, match.resourceName, {
          updatePersonFields: UPDATE_FIELDS
        });
        Logger.log('Merged: ' + primaryName(person));
        mergedCount++;
      } catch(e) {
        Logger.log('Merge failed for ' + primaryName(person) + ': ' + e);
        failedCount++;
        errors.push('Merge failed: ' + primaryName(person) + ' — ' + e.message);
      }
    } else {
      // No match found — create as a new contact
      var success = createContact(person);
      if (success) {
        newCount++;
      } else {
        failedCount++;
        errors.push('Create failed: ' + primaryName(person));
      }
    }

    // Mark row as imported regardless of success, to avoid reprocessing
    sheet.getRange(i + 1, 4).setValue('imported');
  }

  writeLog(me, 'pull', 0, newCount, mergedCount, failedCount, errors.join('; '));
}

// ============================================================
// MATCHING
// A contact is considered a match if:
//   1. Any email address on the incoming contact matches any
//      email address on the existing contact (any-to-any), AND
//   2. The full display name matches exactly (case-insensitive)
// Both conditions must be true to prevent false matches where
// different people share an email address or name alone.
// ============================================================

/**
 * Attempts to find an existing contact in this account that matches
 * the incoming contact by any email address AND full display name.
 * @param {Object} person - The incoming contact body.
 * @param {Object} indexed - Object with byEmail map of existing contacts.
 * @return {Object|null} The matching existing contact, or null if none found.
 */
function findExactMatch(person, indexed) {
  var name = primaryName(person);
  if (!name) return null; // Cannot match without a name

  // Collect all email addresses from the incoming contact
  var incomingEmails = (person.emailAddresses || [])
    .map(function(e) { return (e.value || '').toLowerCase(); })
    .filter(Boolean);

  if (!incomingEmails.length) return null; // Cannot match without an email

  // Check each incoming email against the index of existing contacts
  for (var i = 0; i < incomingEmails.length; i++) {
    var candidate = indexed.byEmail[incomingEmails[i]];
    if (!candidate) continue;

    var candidateName = primaryName(candidate);
    if (!candidateName) continue;

    // Require full display name match (case-insensitive)
    if (candidateName.toLowerCase() === name.toLowerCase()) {
      return candidate;
    }
  }

  return null;
}

// ============================================================
// MERGE
// When a match is found, incoming data is merged into the
// existing contact rather than overwriting it entirely:
//
//   Array fields (phones, addresses, URLs, etc.): incoming
//   items are appended to the existing list. This may result
//   in duplicate numbers or addresses if both accounts hold
//   the same data — these can be cleaned up manually.
//
//   Scalar fields (name, birthday, bio, etc.): incoming value
//   wins if non-empty, otherwise the existing value is kept.
// ============================================================

/**
 * Merges two contact bodies together. Array fields are concatenated;
 * scalar fields prefer the incoming value if present.
 * @param {Object} existing - The current contact body from this account.
 * @param {Object} incoming - The contact body from the other account.
 * @return {Object} The merged contact body.
 */
function mergeContactBody(existing, incoming) {
  // Fields that can have multiple values — append incoming to existing
  var arrayFields = [
    'emailAddresses', 'phoneNumbers', 'addresses', 'urls',
    'relations', 'events', 'imClients', 'miscKeywords', 'userDefined'
  ];

  // Fields with a single value — incoming wins if non-empty
  var scalarFields = [
    'names', 'nicknames', 'organizations', 'birthdays',
    'biographies', 'occupations', 'interests', 'locales',
    'locations', 'genders'
  ];

  var body = Object.assign({}, existing);

  arrayFields.forEach(function(f) {
    if (incoming[f] && incoming[f].length) {
      body[f] = (body[f] || []).concat(incoming[f]);
    }
  });

  scalarFields.forEach(function(f) {
    if (incoming[f] && incoming[f].length) {
      body[f] = incoming[f];
    }
  });

  return body;
}

// ============================================================
// PEOPLE API HELPERS
// Functions that interact directly with the Google People API.
// ============================================================

/**
 * Returns all contacts in this account that are members of the
 * "share" contact group. Fetches full contact details for all
 * members in batches of 200 (the API maximum per request).
 * @return {Array} Array of person objects.
 */
function getShareContacts() {
  // Find the contact group named LABEL_NAME
  var groupsResp = People.ContactGroups.list();
  var groups = groupsResp.contactGroups || [];
  var group = groups.filter(function(g) {
    return g.name.toLowerCase() === LABEL_NAME.toLowerCase();
  })[0];

  if (!group) {
    Logger.log('No label "' + LABEL_NAME + '" found.');
    return [];
  }

  // Fetch the group's member resource names
  var detail = People.ContactGroups.get(group.resourceName, { maxMembers: 1000 });
  var members = detail.memberResourceNames || [];
  if (!members.length) return [];

  // Batch fetch full contact details (max 200 per request)
  var results = [];
  for (var i = 0; i < members.length; i += 200) {
    var batch = members.slice(i, i + 200);
    var resp = People.People.getBatchGet({
      resourceNames: batch,
      personFields: PERSON_FIELDS + ',metadata'
    });
    (resp.responses || []).forEach(function(r) {
      if (r.person) results.push(r.person);
    });
  }
  return results;
}

/**
 * Fetches all contacts in this account and indexes them by every
 * email address they have. A single contact with two email addresses
 * will appear twice in the index, once per email. This supports
 * any-to-any email matching in findExactMatch.
 * @return {Object} Object with byEmail property mapping email → person.
 */
function getAllContactsIndexed() {
  var byEmail = {};
  var pageToken = null;

  do {
    var params = {
      personFields: PERSON_FIELDS + ',metadata',
      pageSize: 1000
    };
    if (pageToken) params.pageToken = pageToken;

    var resp = People.People.Connections.list('people/me', params);

    (resp.connections || []).forEach(function(p) {
      // Index by ALL email addresses, not just the primary
      (p.emailAddresses || []).forEach(function(e) {
        if (e.value) byEmail[e.value.toLowerCase()] = p;
      });
    });

    pageToken = resp.nextPageToken;
  } while (pageToken);

  return { byEmail: byEmail };
}

/**
 * Creates a new contact in this account from the given person body,
 * then adds it to the "share" contact group.
 * @param {Object} person - The contact body to create.
 * @return {boolean} True if creation succeeded, false if it failed.
 */
function createContact(person) {
  var body = buildContactBody(person);
  try {
    var created = People.People.createContact(body);
    addToShareGroup(created.resourceName);
    Logger.log('Created: ' + primaryName(person));
    return true;
  } catch(e) {
    Logger.log('Create failed for ' + primaryName(person) + ': ' + e);
    return false;
  }
}

/**
 * Adds a contact to the "share" contact group in this account.
 * Creates the group first if it doesn't exist.
 * @param {string} resourceName - The contact's People API resource name.
 */
function addToShareGroup(resourceName) {
  var groupsResp = People.ContactGroups.list();
  var groups = groupsResp.contactGroups || [];
  var group = groups.filter(function(g) {
    return g.name.toLowerCase() === LABEL_NAME.toLowerCase();
  })[0];

  if (!group) {
    // Create the group if it doesn't exist in this account
    var newGroup = People.ContactGroups.create({ contactGroup: { name: LABEL_NAME } });
    group = newGroup;
  }

  People.ContactGroups.Members.modify(
    { resourceNamesToAdd: [resourceName] },
    group.resourceName
  );
}

// ============================================================
// SERIALIZATION
// Contacts are stored in the Sheet as JSON blobs so that all
// fields can be round-tripped without requiring one column per
// field. The metadata field is stripped before storage as it
// contains read-only API data that would cause errors on write.
// ============================================================

/**
 * Serializes a contact into a Sheet row: [fingerprint, source, json, status].
 * @param {Object} person - The contact to serialize.
 * @param {string} me - The current account's email address.
 * @param {string} fp - The contact's fingerprint string.
 * @return {Array} A four-element array representing the Sheet row.
 */
function serializeContact(person, me, fp) {
  var blob = buildContactBody(person);
  return [fp, me, JSON.stringify(blob), ''];
}

/**
 * Deserializes a Sheet row back into a contact body object.
 * Returns null if the JSON is malformed.
 * @param {Array} row - A Sheet row array.
 * @return {Object|null} The contact body, or null on parse failure.
 */
function deserializeContact(row) {
  try {
    return JSON.parse(row[2]);
  } catch(e) {
    return null;
  }
}

/**
 * Extracts all writable fields from a person object into a clean
 * contact body suitable for create or update API calls. Strips
 * the metadata sub-field from each field item, as it is read-only.
 * @param {Object} person - The source person object.
 * @return {Object} A clean contact body.
 */
function buildContactBody(person) {
  var fields = [
    'names', 'nicknames', 'emailAddresses', 'phoneNumbers',
    'addresses', 'organizations', 'birthdays', 'biographies',
    'urls', 'relations', 'events', 'imClients', 'occupations',
    'interests', 'locales', 'locations', 'miscKeywords',
    'genders', 'userDefined'
  ];
  var body = {};
  fields.forEach(function(f) {
    if (person[f]) {
      body[f] = person[f].map(function(item) {
        var clean = Object.assign({}, item);
        delete clean.metadata; // Remove read-only metadata before writing
        return clean;
      });
    }
  });
  return body;
}

// ============================================================
// SHEET HELPERS
// ============================================================

/**
 * Returns the contacts sheet, creating it with headers if it
 * doesn't already exist.
 * @return {Sheet} The contacts Google Sheet tab.
 */
function getOrCreateSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['fingerprint', 'source', 'data', 'status']);
  }
  return sheet;
}

/**
 * Returns the log sheet, creating it with headers if it
 * doesn't already exist.
 * @return {Sheet} The log Google Sheet tab.
 */
function getOrCreateLogSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['timestamp', 'account', 'direction', 'pushed', 'new', 'merged', 'failed', 'errors']);
    // Freeze header row for readability
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ============================================================
// LOGGING
// When LOGGING_ENABLED is true, each push and pull operation
// writes a summary row to the log sheet containing a timestamp,
// account email, direction, and counts of pushed, new, merged,
// failed contacts, plus any error messages. Because both accounts
// write to the same Sheet, log entries from both accounts appear
// in a single combined chronological view. The log is
// automatically trimmed to LOG_MAX_ROWS to prevent unbounded
// growth. Logging failures are caught silently so they never
// interrupt the sync itself.
// ============================================================

/**
 * Writes a log entry to the log sheet if logging is enabled.
 * Automatically trims the log to LOG_MAX_ROWS after writing.
 * @param {string} account - The account email that ran the sync.
 * @param {string} direction - 'push', 'pull', or 'sync' (for lock failures).
 * @param {number} pushed - Number of contacts pushed to the Sheet.
 * @param {number} newCount - Number of new contacts created.
 * @param {number} merged - Number of contacts merged.
 * @param {number} failed - Number of failed operations.
 * @param {string} errors - Semicolon-separated error messages, if any.
 */
function writeLog(account, direction, pushed, newCount, merged, failed, errors) {
  if (!LOGGING_ENABLED) return;

  try {
    var sheet = getOrCreateLogSheet();
    var timestamp = new Date().toISOString();

    sheet.appendRow([timestamp, account, direction, pushed, newCount, merged, failed, errors || '']);

    // Trim to LOG_MAX_ROWS, keeping the header row
    var totalRows = sheet.getLastRow();
    if (totalRows > LOG_MAX_ROWS + 1) {
      // Delete oldest rows (just after the header) to stay within limit
      var rowsToDelete = totalRows - LOG_MAX_ROWS - 1;
      sheet.deleteRows(2, rowsToDelete);
    }
  } catch(e) {
    // Log failures should never break the sync itself
    Logger.log('Logging failed: ' + e);
  }
}

// ============================================================
// UTILITIES
// ============================================================

/**
 * Generates a stable fingerprint string for a contact, used to
 * identify its row in the Sheet across runs. Uses the primary
 * email if available, then the display name, then falls back to
 * the People API resource name. The account email is prefixed
 * so fingerprints from different accounts never collide.
 * @param {Object} person - The contact to fingerprint.
 * @param {string} me - The current account's email address.
 * @return {string} A fingerprint string.
 */
function fingerprint(person, me) {
  var email = primaryEmail(person);
  if (email) return me + ':email:' + email.toLowerCase();
  var name = primaryName(person);
  if (name) return me + ':name:' + name.toLowerCase();
  // Last resort — resource name is stable within a single account
  return me + ':rn:' + (person.resourceName || Math.random().toString());
}

/**
 * Returns the primary email address for a contact, or null if none.
 * Prefers the address flagged as primary; falls back to the first
 * address in the list.
 * @param {Object} person - The contact object.
 * @return {string|null}
 */
function primaryEmail(person) {
  var emails = person.emailAddresses || [];
  if (!emails.length) return null;
  var primary = emails.filter(function(e) { return e.metadata && e.metadata.primary; })[0];
  return (primary || emails[0]).value || null;
}

/**
 * Returns the primary display name for a contact, or null if none.
 * Prefers the name flagged as primary; falls back to the first
 * name in the list.
 * @param {Object} person - The contact object.
 * @return {string|null}
 */
function primaryName(person) {
  var names = person.names || [];
  if (!names.length) return null;
  var primary = names.filter(function(n) { return n.metadata && n.metadata.primary; })[0];
  return (primary || names[0]).displayName || null;
}
