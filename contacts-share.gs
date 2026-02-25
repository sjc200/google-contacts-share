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
 * Development history and architecture decisions: see DEVELOPMENT.md
 *
 * @version 1.4.0
 * @author sjc200
 * @licence GNU GPL v3
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
var LOG_MAX_ERROR_LENGTH = 1000;              // Maximum characters for the errors column in the log

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
// approach API rate limits (~90 writes/minute).
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
// The user only needs to open the script once — no manual
// function calls required.
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
// the account is not in ACCOUNT_EMAILS so misconfigurations
// are caught immediately rather than silently misbehaving.
// ============================================================

/**
 * Returns the active account's email address, normalised to lowercase.
 * @return {string}
 */
function getMyEmail() {
  return Session.getActiveUser().getEmail().toLowerCase();
}

/**
 * Validates that the active account is one of the two configured
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
// Acquires a script-wide lock (shared across both account
// instances) to prevent concurrent Sheet writes, then runs
// pull followed by push. Pull runs first so that by the time
// push builds its receivedHashSet, any newly received rows
// are already marked "imported" and their hashes are correctly
// included — preventing contacts from being unnecessarily
// pushed back to the account they originated from.
// The lock is always released in a finally block.
// ============================================================
function syncContacts() {
  var me = validateAccount();

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
    pullFromSheet(me); // pull first — see section comment above
    pushToSheet(me);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// PUSH
// Reads all contacts labelled "share" in this account and
// upserts them into the shared Sheet as JSON blobs. Each row
// is identified by a fingerprint so existing rows are updated
// in place rather than duplicated.
//
// Each row stores a normalised hash of the contact data in
// column 5. "Normalised" means API-derived fields are stripped
// before hashing so the hash reflects only user-set data and
// is stable across API round-trips and across accounts.
//
// On each push:
//   - A set of normalised hashes is built from all rows in the
//     Sheet that were received from the other account (source
//     = other account, status = imported). If the current
//     contact's hash appears in this set, it originated from
//     the other account and has not been locally changed —
//     skip it entirely. This works for all contacts regardless
//     of whether they have an email address.
//   - If the contact's hash matches its own stored hash in the
//     Sheet, the data is unchanged — skip writing entirely.
//   - If the hash differs, the contact has changed locally —
//     write the row with blank status so the other account
//     re-pulls the update.
//
// Because pull runs before push in syncContacts, newly received
// rows are already marked "imported" by the time the hash set
// is built, so their hashes are correctly included.
// ============================================================

/**
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

  // Build an index of fingerprint → row number for in-place updates
  var fingerprintIndex = {};
  for (var i = 1; i < existingData.length; i++) {
    fingerprintIndex[existingData[i][0]] = i + 1; // 1-based row number
  }

  // Build a set of normalised hashes from rows received from the other
  // account. Used to skip contacts that originated there and are unchanged.
  var receivedHashSet = {};
  for (var i = 1; i < existingData.length; i++) {
    var existingRow = existingData[i];
    if (existingRow[1].toLowerCase() !== me && existingRow[3] === 'imported') {
      var storedHash = existingRow[4] || '';
      if (storedHash) receivedHashSet[storedHash] = true;
    }
  }

  contacts.forEach(function(person) {
    var fp = fingerprint(person, me);
    var row = serializeContact(person, me, fp);
    var currentHash = row[4];

    // Skip contacts received from the other account that are unchanged
    if (receivedHashSet[currentHash]) {
      Logger.log('Skipped (unchanged, received from other account): ' + primaryName(person));
      return;
    }

    if (fingerprintIndex[fp]) {
      var storedHash = existingData[fingerprintIndex[fp] - 1][4] || '';
      if (currentHash === storedHash) {
        // Data unchanged — skip entirely, Sheet row is already correct
        Logger.log('Skipped (unchanged): ' + primaryName(person));
        return;
      }
      // Data changed — write with blank status so the other account re-pulls
      Logger.log('Pushed (updated): ' + primaryName(person));
      sheet.getRange(fingerprintIndex[fp], 1, 1, row.length).setValues([row]);
    } else {
      Logger.log('Pushed (new): ' + primaryName(person));
      sheet.appendRow(row);
    }
    pushed++;
  });

  writeLog(me, 'push', pushed, 0, 0, 0, '');
}

// ============================================================
// PULL
// Reads rows written by the OTHER account that have not yet
// been imported (blank status). For each row, attempts to find
// a matching contact by any email address AND full display name.
// For contacts with no email address, falls back to name-only
// matching. If matched, the contact is merged using a freshly
// fetched etag to prevent stale etag errors. If not matched,
// a new contact is created. Processed rows are marked "imported"
// so they are never processed again — unless the contact is
// subsequently changed, in which case pushToSheet resets the
// status to blank and the cycle repeats.
// ============================================================

/**
 * @param {string} me - The current account's email address.
 */
function pullFromSheet(me) {
  var sheet = getOrCreateSheet();
  var data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    writeLog(me, 'pull', 0, 0, 0, 0, 'No rows in sheet');
    return;
  }

  var indexed = getAllContactsIndexed();
  var newCount = 0;
  var mergedCount = 0;
  var failedCount = 0;
  var errors = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var source = row[1];
    var status = row[3];

    if (source.toLowerCase() === me) continue;  // skip own rows
    if (status === 'imported') continue;         // skip already processed rows

    var person = deserializeContact(row);
    if (!person) {
      failedCount++;
      errors.push('Row ' + (i + 1) + ': failed to deserialize');
      continue;
    }

    var match = findExactMatch(person, indexed);
    if (match) {
      var body = mergeContactBody(buildContactBody(match), buildContactBody(person));
      try {
        // Re-fetch immediately before updating to get a guaranteed fresh etag
        var fresh = People.People.get(match.resourceName, {
          personFields: PERSON_FIELDS + ',metadata'
        });
        body.etag = fresh.etag;
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
      var success = createContact(person);
      if (success) {
        newCount++;
      } else {
        failedCount++;
        errors.push('Create failed: ' + primaryName(person));
      }
    }

    sheet.getRange(i + 1, 4).setValue('imported');
  }

  writeLog(me, 'pull', 0, newCount, mergedCount, failedCount, errors.join('; '));
}

// ============================================================
// MATCHING
// Primary match: any email on the incoming contact matches any
// email on an existing contact (any-to-any), AND the full
// display name matches exactly (case-insensitive).
//
// Fallback match: if the incoming contact has no email address,
// match by display name alone via the byName index. This handles
// contacts like businesses or services with no email address.
//
// Requiring name in both cases prevents false matches where
// different contacts share a common identifier.
// ============================================================

/**
 * @param {Object} person - The incoming contact body.
 * @param {Object} indexed - Object with byEmail and byName maps.
 * @return {Object|null} Matching existing contact, or null if not found.
 */
function findExactMatch(person, indexed) {
  var name = primaryName(person);
  if (!name) return null;

  var incomingEmails = (person.emailAddresses || [])
    .map(function(e) { return (e.value || '').toLowerCase(); })
    .filter(Boolean);

  if (incomingEmails.length) {
    // Primary match: any email + name
    for (var i = 0; i < incomingEmails.length; i++) {
      var candidate = indexed.byEmail[incomingEmails[i]];
      if (!candidate) continue;
      var candidateName = primaryName(candidate);
      if (!candidateName) continue;
      if (candidateName.toLowerCase() === name.toLowerCase()) {
        return candidate;
      }
    }
  } else {
    // Fallback: name-only match for contacts with no email
    var nameCandidate = indexed.byName[name.toLowerCase()];
    if (nameCandidate) return nameCandidate;
  }

  return null;
}

// ============================================================
// MERGE
// Array fields (phones, addresses, URLs, etc.) are appended
// and deduplicated by the item's primary value field (e.g.
// the phone number string itself) rather than the full JSON
// object. This prevents duplicate entries caused by minor
// differences in field ordering or metadata between accounts.
// Scalar fields (name, birthday, etc.) are overwritten by the
// incoming value if non-empty, otherwise the existing value
// is kept.
// ============================================================

/**
 * @param {Object} existing - The current contact body from this account.
 * @param {Object} incoming - The contact body from the other account.
 * @return {Object} The merged contact body.
 */
function mergeContactBody(existing, incoming) {
  var arrayFields = [
    'emailAddresses', 'phoneNumbers', 'addresses', 'urls',
    'relations', 'events', 'imClients', 'miscKeywords', 'userDefined'
  ];
  var scalarFields = [
    'names', 'nicknames', 'organizations', 'birthdays',
    'biographies', 'occupations', 'interests', 'locales',
    'locations', 'genders'
  ];

  var body = Object.assign({}, existing);

  arrayFields.forEach(function(f) {
    if (incoming[f] && incoming[f].length) {
      var combined = (body[f] || []).concat(incoming[f]);
      var seen = {};
      body[f] = combined.filter(function(item) {
        // Deduplicate by the item's primary value field to avoid false
        // duplicates caused by metadata differences between accounts
        var key = item.value || item.formattedValue ||
                  item.canonicalForm || JSON.stringify(item);
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
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
 * "share" contact group, fetched in batches of 200 (API maximum).
 * @return {Array} Array of person objects.
 */
function getShareContacts() {
  var groupsResp = People.ContactGroups.list();
  var groups = groupsResp.contactGroups || [];
  var group = groups.filter(function(g) {
    return g.name.toLowerCase() === LABEL_NAME.toLowerCase();
  })[0];

  if (!group) {
    Logger.log('No label "' + LABEL_NAME + '" found.');
    return [];
  }

  var detail = People.ContactGroups.get(group.resourceName, { maxMembers: 1000 });
  var members = detail.memberResourceNames || [];
  if (!members.length) return [];

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
 * email address they have (for primary matching) and by display
 * name (for fallback matching of contacts with no email).
 * @return {Object} Object with byEmail and byName maps.
 */
function getAllContactsIndexed() {
  var byEmail = {};
  var byName = {};
  var pageToken = null;

  do {
    var params = { personFields: PERSON_FIELDS + ',metadata', pageSize: 1000 };
    if (pageToken) params.pageToken = pageToken;
    var resp = People.People.Connections.list('people/me', params);
    (resp.connections || []).forEach(function(p) {
      (p.emailAddresses || []).forEach(function(e) {
        if (e.value) byEmail[e.value.toLowerCase()] = p;
      });
      var name = primaryName(p);
      if (name) byName[name.toLowerCase()] = p;
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);

  return { byEmail: byEmail, byName: byName };
}

/**
 * Creates a new contact and adds it to the "share" group.
 * @param {Object} person - The contact body to create.
 * @return {boolean} True on success, false on failure.
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
 * Adds a contact to the "share" group, creating the group if needed.
 * @param {string} resourceName - The contact's People API resource name.
 */
function addToShareGroup(resourceName) {
  var groupsResp = People.ContactGroups.list();
  var groups = groupsResp.contactGroups || [];
  var group = groups.filter(function(g) {
    return g.name.toLowerCase() === LABEL_NAME.toLowerCase();
  })[0];

  if (!group) {
    group = People.ContactGroups.create({ contactGroup: { name: LABEL_NAME } });
  }

  People.ContactGroups.Members.modify(
    { resourceNamesToAdd: [resourceName] },
    group.resourceName
  );
}

// ============================================================
// SERIALIZATION
// Contacts are stored as JSON blobs so all fields round-trip
// without requiring one column per field. The metadata sub-field
// is stripped before storage as it is read-only and would cause
// errors on write.
//
// Each row is five columns: fingerprint | source | data | status | hash
//
// The hash is computed from a normalised version of the contact
// body where API-derived fields are stripped before hashing.
// This ensures the hash reflects only user-set data and is
// stable across API round-trips and across accounts, even when
// Google adds or reformats fields like formattedType or
// canonicalForm on create or read.
//
// Fields stripped before hashing — from all items:
//   formattedType, canonicalForm
// Additionally stripped from names items:
//   displayName, displayNameLastFirst, unstructuredName
// ============================================================

/**
 * Serializes a contact into a five-element Sheet row.
 * @param {Object} person - The contact to serialize.
 * @param {string} me - The current account's email address.
 * @param {string} fp - The contact's fingerprint string.
 * @return {Array} [fingerprint, source, json, status, hash]
 */
function serializeContact(person, me, fp) {
  var body = buildContactBody(person);
  var json = JSON.stringify(body);
  return [fp, me, json, '', stableHash(normaliseForHash(body))];
}

/**
 * Deserializes a Sheet row into a contact body. Returns null if
 * the JSON is malformed.
 * @param {Array} row - A Sheet row array.
 * @return {Object|null}
 */
function deserializeContact(row) {
  try {
    return JSON.parse(row[2]);
  } catch(e) {
    return null;
  }
}

/**
 * Extracts all writable fields from a person object, stripping
 * the read-only metadata sub-field from each item.
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
        delete clean.metadata;
        return clean;
      });
    }
  });
  return body;
}

/**
 * Strips API-derived fields from a contact body before hashing
 * so the hash reflects only user-set data.
 * @param {Object} body - A clean contact body from buildContactBody.
 * @return {Object} A normalised copy suitable for hashing.
 */
function normaliseForHash(body) {
  var allItemFields = ['formattedType', 'canonicalForm'];
  var nameOnlyFields = ['displayName', 'displayNameLastFirst', 'unstructuredName'];
  var result = {};
  Object.keys(body).forEach(function(f) {
    result[f] = body[f].map(function(item) {
      var clean = Object.assign({}, item);
      allItemFields.forEach(function(k) { delete clean[k]; });
      if (f === 'names') {
        nameOnlyFields.forEach(function(k) { delete clean[k]; });
      }
      return clean;
    });
  });
  return result;
}

// ============================================================
// SHEET HELPERS
// ============================================================

/**
 * Returns the contacts sheet, creating it with headers if needed.
 * @return {Sheet}
 */
function getOrCreateSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['fingerprint', 'source', 'data', 'status', 'hash']);
  }
  return sheet;
}

/**
 * Returns the log sheet, creating it with a frozen header row if needed.
 * @return {Sheet}
 */
function getOrCreateLogSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['timestamp', 'account', 'direction', 'pushed', 'new', 'merged', 'failed', 'errors']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ============================================================
// LOGGING
// When LOGGING_ENABLED is true, each push and pull appends a
// summary row to the log sheet. Both accounts write to the same
// sheet so all activity appears in a single chronological view.
// The log is trimmed to LOG_MAX_ROWS automatically. Error strings
// are capped at LOG_MAX_ERROR_LENGTH to avoid exceeding Google
// Sheets' 50,000 character cell limit. Logging failures are
// caught silently so they never interrupt the sync.
// ============================================================

/**
 * Appends a log entry if logging is enabled, then trims old rows.
 * @param {string} account - Email of the account that ran the sync.
 * @param {string} direction - 'push', 'pull', or 'sync' (lock failure).
 * @param {number} pushed - Contacts pushed to the Sheet.
 * @param {number} newCount - New contacts created.
 * @param {number} merged - Contacts merged.
 * @param {number} failed - Failed operations.
 * @param {string} errors - Semicolon-separated error messages.
 */
function writeLog(account, direction, pushed, newCount, merged, failed, errors) {
  if (!LOGGING_ENABLED) return;
  try {
    var sheet = getOrCreateLogSheet();
    var safeErrors = (errors || '').toString().substring(0, LOG_MAX_ERROR_LENGTH);
    sheet.appendRow([new Date().toISOString(), account, direction, pushed, newCount, merged, failed, safeErrors]);
    var totalRows = sheet.getLastRow();
    if (totalRows > LOG_MAX_ROWS + 1) {
      sheet.deleteRows(2, totalRows - LOG_MAX_ROWS - 1);
    }
  } catch(e) {
    Logger.log('Logging failed: ' + e);
  }
}

// ============================================================
// DEBUG HELPER
// Run debugSheet() manually from the Apps Script editor to
// print a readable summary of the contacts Sheet to the log.
// ============================================================

/**
 * Prints a diagnostic summary of the contacts Sheet to the log.
 * Run manually from the Apps Script editor when needed.
 */
function debugSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  var data = sheet.getDataRange().getValues();

  Logger.log('Total rows (inc header): ' + data.length);
  Logger.log('---');

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var name = '(unknown)';
    var emailCount = 0;
    try {
      var person = JSON.parse(row[2]);
      if (person.names && person.names[0]) name = person.names[0].displayName;
      emailCount = (person.emailAddresses || []).length;
    } catch(e) {}
    Logger.log('Row ' + i + ': ' + name +
               ' | source: ' + row[1] +
               ' | status: ' + (row[3] || '(blank)') +
               ' | emails in blob: ' + emailCount +
               ' | hash: ' + (row[4] || '(none)') +
               ' | fingerprint: ' + row[0]);
  }
}

// ============================================================
// UTILITIES
// normaliseForHash — strips API-derived fields before hashing
// stableHash / stableStringify — field-order-independent hash
// simpleHash — underlying numeric hash function
// fingerprint — stable Sheet row identifier per contact
// primaryEmail / primaryName — extract primary field values
// ============================================================

/**
 * Computes a hash of an object that is stable regardless of the
 * order in which fields or array items appear. Safe for
 * cross-account comparisons where the same contact may have
 * fields in a different order depending on the API response.
 * @param {Object} obj
 * @return {string} Hash as a base-36 string.
 */
function stableHash(obj) {
  return simpleHash(stableStringify(obj));
}

/**
 * Serializes a value to a JSON string with object keys sorted
 * alphabetically at every level and array items sorted by their
 * serialized representation, ensuring consistent output regardless
 * of field or item ordering.
 * @param {*} val
 * @return {string}
 */
function stableStringify(val) {
  if (Array.isArray(val)) {
    return '[' + val.map(stableStringify).sort().join(',') + ']';
  }
  if (val && typeof val === 'object') {
    return '{' + Object.keys(val).sort().map(function(k) {
      return JSON.stringify(k) + ':' + stableStringify(val[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(val);
}

/**
 * Computes a simple numeric hash of a string. Not cryptographic —
 * collision resistance is sufficient for change detection purposes.
 * @param {string} str
 * @return {string} Hash as a base-36 string.
 */
function simpleHash(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generates a stable fingerprint for a contact to identify its
 * Sheet row across runs. Prefixed with the account email so
 * fingerprints from different accounts never collide. Falls back
 * from primary email → display name → resource name.
 * @param {Object} person
 * @param {string} me
 * @return {string}
 */
function fingerprint(person, me) {
  var email = primaryEmail(person);
  if (email) return me + ':email:' + email.toLowerCase();
  var name = primaryName(person);
  if (name) return me + ':name:' + name.toLowerCase();
  return me + ':rn:' + (person.resourceName || Math.random().toString());
}

/**
 * Returns the primary email address for a contact, or null if none.
 * Prefers the address flagged as primary; falls back to the first.
 * @param {Object} person
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
 * Prefers the name flagged as primary; falls back to the first.
 * @param {Object} person
 * @return {string|null}
 */
function primaryName(person) {
  var names = person.names || [];
  if (!names.length) return null;
  var primary = names.filter(function(n) { return n.metadata && n.metadata.primary; })[0];
  return (primary || names[0]).displayName || null;
}
