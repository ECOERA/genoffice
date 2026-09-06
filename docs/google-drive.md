# Google Drive in DuneOffice

DuneOffice can sign in to a Google account, list the documents on that Drive
that its editors can open, download one into a local cache, open it in the
matching editor, and upload the file back to Drive whenever the editor saves
it. Google Docs, Sheets and Slides are exported to `.docx`, `.xlsx` and
`.pptx` on the way down and converted back on the way up.

## Setting up the Google side (once per organisation)

Google only issues OAuth tokens to a registered client, so DuneOffice needs a
client id from a Google Cloud project you control. This takes about ten
minutes and is free.

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and
   create a project (for example "DuneOffice").
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (Google now calls this "Google
   Auth platform → Branding / Audience"):
   - App name "DuneOffice", your support email, your developer email.
   - **User type / Audience.** If your Google account belongs to a Google
     Workspace organisation (a company domain such as `ecoera.se`), choose
     **Internal**: everyone in the organisation can sign in, Google requires
     no verification, and refresh tokens do not expire. If the account is a
     personal Gmail, choose **External** and add each tester under
     **Test users** (up to 100). In that "Testing" state Google expires
     refresh tokens after seven days, so testers sign in again weekly.
   - Scopes: add `.../auth/drive`, `.../auth/userinfo.email` and
     `.../auth/userinfo.profile`. Full Drive access is what lets the app list
     your existing files; Google calls it a restricted scope, which is only a
     concern for External apps that want to leave the Testing state (that
     requires Google's verification review).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   application type **Desktop app**, name "DuneOffice". Copy the **Client ID**
   and the **Client secret**. Google does not treat a desktop client's secret
   as confidential (it ships inside the app); the code exchange is protected
   by PKCE.

## Giving DuneOffice the client

Any one of these, in order of precedence:

- **Settings → Account → Google Drive**: paste the client id and secret. This
  is stored in `app-settings.json` under `googleClientId` /
  `googleClientSecret` and is the right way for a tester who received a dmg
  without a baked-in client.
- Environment variables `DUNEOFFICE_GOOGLE_CLIENT_ID` and
  `DUNEOFFICE_GOOGLE_CLIENT_SECRET` (dev runs).
- Baked into a packaged build: set the same two variables when running
  `electron-builder`; `apps/shell/electron-builder.cjs` writes them into the
  packaged `package.json` as `duneofficeGoogle`, the same way the analytics
  keys are injected. A build made this way works for testers out of the box.

## Using it

- Home → **Google Drive** in the sidebar. The first visit shows a
  **Sign in with Google** button; it opens the system browser, and the app
  receives the result on a loopback address (`http://127.0.0.1:<port>`), so
  no password ever passes through DuneOffice.
- The list shows every file the editors can open (Word, Excel, PowerPoint,
  PDF, Markdown, CSV and Google Docs/Sheets/Slides), newest first, with a
  search box. Click a row to open it; the file is downloaded to
  `<userData>/google-drive/files/<fileId>/` and opened in the right editor.
- Saving in the editor (including autosave) uploads the file back to the same
  Drive file about 1.5 s after the last write. Rows in the Drive list show
  when the local copy was last synced. A failed upload is reported in the
  Drive view; the local copy is kept, and the next save retries.
- **Settings → Account → Google Drive** shows the signed-in account and has
  **Sign out**, which revokes the token at Google and deletes the local copy.

## What is stored where

| What                                          | Where                                           | Protection                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth tokens + account email                  | `<userData>/google-drive/auth.json`             | Encrypted with Electron `safeStorage` (macOS Keychain / Windows DPAPI / Linux secret service); plain with mode 0600 only where no OS store exists |
| Cached documents                              | `<userData>/google-drive/files/<fileId>/<name>` | Ordinary files; deleted with the app data                                                                                                         |
| Cache index (path → Drive file, sync markers) | `<userData>/google-drive/index.json`            | Plain JSON, no secrets                                                                                                                            |
| OAuth client id/secret (when set in Settings) | `<userData>/app-settings.json`                  | Plain; not confidential for a desktop client                                                                                                      |

## Design notes

- `apps/shell/src/main/google-drive-api.ts` is pure Node: PKCE, the loopback
  redirect server, token refresh, and the Drive v3 calls (`files.list`,
  `files.get`, `files.export`, media `PATCH` update, multipart create). It
  takes a `fetch` implementation so the tests run against a fake.
- `apps/shell/src/main/google-drive.ts` holds the state: the token store, the
  cache index, and the write-back watchers. Write-back needs no hook in the
  editors: each cached file lives alone in its own folder, that folder is
  watched with `fs.watch`, and any write (plain save, autosave, temp+rename)
  schedules an upload once writes settle. Uploads are serialised per file and
  skipped when the mtime still matches the last sync.
- Opening a file that is already cached re-downloads only when Drive's
  `modifiedTime` changed and the local copy carries no unsynced edits;
  otherwise the local copy wins.
- Everything is reachable through `window.aiOffice.googleDrive*` in the Home
  renderer (`apps/shell/src/shared/home-api.ts`), following the Genspark
  Projects section's shape.
- Not done: conflict detection when the same Drive file is edited elsewhere
  while a local copy has unsynced changes (last writer wins), "save as" into
  a Drive folder from inside an editor, shared-drive folder browsing, and a
  file picker for `drive.file`-only scope.
