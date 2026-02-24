// ============================================================
// CONFIGURATION — same in both accounts, no changes needed
// except SHEET_ID and ACCOUNT_EMAILS
// ============================================================
var SHEET_ID = 'YOUR_SHEET_ID_HERE';
var SHEET_NAME = 'contacts';
var LABEL_NAME = 'share';
var ACCOUNT_EMAILS = ['account1@gmail.com', 'account2@gmail.com'];

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
// Installs trigger and runs initial sync automatically
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
// ============================================================
function createTrigger() {
  ScriptApp.newTrigger('syncContacts')
    .timeBased()
    .everyMinutes(15)
    .create();
}

// ============================================================
// IDENTITY — detected at runtime
// ============================================================
function getMyEmail() {
  return Session.getActiveUser().getEmail().toLowerCase();
}

function validateAccount() {
  var me = getMyEmail();
  if (ACCOUNT_EMAILS.map(function(e){ return e.toLowerCase(); }).indexOf(me) === -1) {
    throw new Error('Running as ' + me + ' which is not in ACCOUNT_EMAILS. Check your config.');
  }
  return me;
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================
function syncContacts() {
  var me = validateAccount();
  pushToSheet(me);
  pullFromSheet(me);
}

// ============================================================
// PUSH: read "share" contacts from this account → write to Sheet
// ============================================================
function pushToSheet(me) {
  var contacts = getShareContacts();
  if (!contacts.length) return;

  var sheet = getOrCreateSheet();
  var existingData = sheet.getDataRange().getValues();

  var fingerprintIndex = {};
  for (var i = 1; i < existingData.length; i++) {
    fingerprintIndex[existingData[i][0]] = i + 1;
  }

  contacts.forEach(function(person) {
    var fp = fingerprint(person, me);
    var row = serializeContact(person, me, fp);
    if (fingerprintIndex[fp]) {
      sheet.getRange(fingerprintIndex[fp], 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  });
}

// ============================================================
// PULL: read Sheet rows from the OTHER account → merge or create
// ============================================================
function pullFromSheet(me) {
  var sheet = getOrCreateSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return;

  var indexed = getAllContactsIndexed();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[1].toLowerCase() === me) continue;
    if (row[3] === 'imported') continue;

    var person = deserializeContact(row);
    if (!person) continue;

    var match = findExactMatch(person, indexed);
    if (match) {
      var body = mergeContactBody(buildContactBody(match), buildContactBody(person));
      body.etag = match.etag;
      try {
        People.People.updateContact(body, match.resourceName, {
          updatePersonFields: UPDATE_FIELDS
        });
        Logger.log('Merged: ' + primaryName(person));
      } catch(e) {
        Logger.log('Merge failed for ' + primaryName(person) + ': ' + e);
      }
    } else {
      createContact(person);
    }

    sheet.getRange(i + 1, 4).setValue('imported');
  }
}

// ============================================================
// MATCHING — any email on incoming matches any email on existing,
// AND full display name matches (case-insensitive)
// ============================================================
function findExactMatch(person, indexed) {
  var name = primaryName(person);
  if (!name) return null;

  var incomingEmails = (person.emailAddresses || [])
    .map(function(e) { return (e.value || '').toLowerCase(); })
    .filter(Boolean);

  if (!incomingEmails.length) return null;

  for (var i = 0; i < incomingEmails.length; i++) {
    var candidate = indexed.byEmail[incomingEmails[i]];
    if (!candidate) continue;
    var candidateName = primaryName(candidate);
    if (!candidateName) continue;
    if (candidateName.toLowerCase() === name.toLowerCase()) {
      return candidate;
    }
  }

  return null;
}

// ============================================================
// MERGE — array fields are appended; scalar fields prefer
// incoming value if non-empty, otherwise keep existing
// ============================================================
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
// ============================================================
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
      // Index by ALL email addresses on the contact
      (p.emailAddresses || []).forEach(function(e) {
        if (e.value) byEmail[e.value.toLowerCase()] = p;
      });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return { byEmail: byEmail };
}

function createContact(person) {
  var body = buildContactBody(person);
  try {
    var created = People.People.createContact(body);
    addToShareGroup(created.resourceName);
    Logger.log('Created: ' + primaryName(person));
  } catch(e) {
    Logger.log('Create failed for ' + primaryName(person) + ': ' + e);
  }
}

function addToShareGroup(resourceName) {
  var groupsResp = People.ContactGroups.list();
  var groups = groupsResp.contactGroups || [];
  var group = groups.filter(function(g) {
    return g.name.toLowerCase() === LABEL_NAME.toLowerCase();
  })[0];
  if (!group) {
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
// ============================================================
function serializeContact(person, me, fp) {
  var blob = buildContactBody(person);
  return [fp, me, JSON.stringify(blob), ''];
}

function deserializeContact(row) {
  try {
    return JSON.parse(row[2]);
  } catch(e) {
    return null;
  }
}

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

// ============================================================
// SHEET HELPERS
// ============================================================
function getOrCreateSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['fingerprint', 'source', 'data', 'status']);
  }
  return sheet;
}

// ============================================================
// UTILITIES
// ============================================================
function fingerprint(person, me) {
  var email = primaryEmail(person);
  if (email) return me + ':email:' + email.toLowerCase();
  var name = primaryName(person);
  if (name) return me + ':name:' + name.toLowerCase();
  return me + ':rn:' + (person.resourceName || Math.random().toString());
}

function primaryEmail(person) {
  var emails = person.emailAddresses || [];
  if (!emails.length) return null;
  var primary = emails.filter(function(e) { return e.metadata && e.metadata.primary; })[0];
  return (primary || emails[0]).value || null;
}

function primaryName(person) {
  var names = person.names || [];
  if (!names.length) return null;
  var primary = names.filter(function(n) { return n.metadata && n.metadata.primary; })[0];
  return (primary || names[0]).displayName || null;
}
