# Security Policy

## Supported Versions

Only the latest release is actively maintained. Security fixes will not be backported to older versions.

| Version | Supported |
|---|---|
| Latest | ✅ |
| Older | ❌ |

---

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not open a public issue**. Instead, report it privately via GitHub's [Security Advisories](https://github.com/sjc200/google-contacts-share/security/advisories/new) feature.

Please include:
- A description of the vulnerability
- Steps to reproduce it
- Any potential impact you can identify

You can expect an acknowledgement within 7 days. If confirmed, a fix will be prioritised and a patched release published as soon as possible.

---

## Security Considerations

This script handles personal contact data. Users should be aware of the following:

- **Data stays within your Google ecosystem** — no data is sent to any external server or third party
- **The shared Sheet is your responsibility** — ensure it is only shared with the intended second account and not made publicly accessible
- **Credentials are never stored in the script** — `SHEET_ID` and `ACCOUNT_EMAILS` are configuration values only, not authentication credentials
- **OAuth tokens are managed by Google Apps Script** — the script never handles or stores OAuth tokens directly; all authentication is managed by Google
- **Review before running** — as with any script that accesses your Google account, you should review the code before authorising it

---

## Scope

This is a small personal utility script. Reports relating to the following are out of scope:

- Vulnerabilities in Google Apps Script, the People API, or Google Sheets themselves
- Issues that require physical access to a user's device or Google account
- Social engineering attacks
