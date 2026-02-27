# Contributing to Google Contacts Share

Thanks for your interest in contributing. This is a small personal utility project - I'd wanted something to do this for a long time, but couldnt find anything suitable / reliable / free. Contributions are very welcome but please read the guidelines below before submitting.

---

## Reporting Issues

If you find a bug or unexpected behaviour:

- Check the [existing issues](https://github.com/sjc200/google-contacts-share/issues) first to avoid duplicates
- Open a new issue with a clear title and description
- Include the following where relevant:
  - What you expected to happen
  - What actually happened
  - Any error messages from the Apps Script execution log
  - Output of running `debugSheet()` from the Apps Script editor
  - Whether the issue affects one account or both

Please do **not** include your actual `SHEET_ID`, email addresses, or any contact data in issue reports.

---

## Suggesting Features

Open an issue with the label `enhancement` and describe:

- What you'd like the script to do
- Why it would be useful
- Any edge cases or risks you can think of

---

## Submitting a Pull Request

1. Fork the repository
2. Create a branch with a descriptive name (e.g. `fix-duplicate-push` or `add-deletion-sync`)
3. Make your changes to `contacts-share.gs`
4. Test thoroughly with two real Google accounts before submitting — see the testing checklist below
5. Update `README.md` if your change affects configuration, behaviour, or limits
6. Update the `@version` tag in the file-level comment block (increment the patch version for fixes, minor version for new features)
7. Open a pull request with a clear description of what changed and why

---

## Testing Checklist

Before submitting a pull request, verify the following manually:

- [ ] A new contact in Account 2 is created correctly in Account 1 on first sync
- [ ] A contact existing in both accounts is merged cleanly without errors
- [ ] Subsequent sync runs produce no activity when nothing has changed
- [ ] Array fields (phone numbers, emails, etc.) do not accumulate duplicates across runs
- [ ] The log tab records entries correctly from both accounts
- [ ] `debugSheet()` runs without errors and produces readable output
- [ ] No credentials, email addresses, or Sheet IDs are hardcoded in the submitted code

---

## Code Style

- The script uses ES5-compatible JavaScript (required by Google Apps Script)
- All functions should have JSDoc comments explaining parameters and return values
- All code sections should have a descriptive block comment header
- Configuration constants should be at the top of the file in the config section
- Avoid introducing external dependencies — the script should remain self-contained

---

## Pull Request Expectations

Pull requests should:
- Be focused on a single issue or feature
- Avoid large refactors unrelated to the change
- Preserve existing behaviour unless clearly justified
- Include a brief explanation of design decisions if the logic is non-trivial

Large architectural rewrites are unlikely to be accepted.

---

## Scope

This project intentionally stays simple. The following are out of scope and unlikely to be accepted as pull requests:

- Syncing more than two accounts
- Deletion sync (too high a risk of data loss)
- A UI or sidebar within Google Sheets
- Any external API calls outside of Google's own services

---

## Questions

If you're unsure whether something is worth contributing, open an issue and ask first.
