# Cloud sync: connect Google Drive or OneDrive

The cloud connector is **optional** and off by default. Your notebooks never leave the device unless you connect an
account here, and then they go only to that account: the plugin has no server, no telemetry and no shared app.

**The plugin ships no client ID and no secret.** You register your own small OAuth app with Google or Microsoft (free,
about ten minutes, once) and paste its ID into the plugin. That way:

- the access you grant belongs to an app you own and can delete at any time;
- no third party (not even the plugin's author) holds credentials that reach your files;
- the plugin does not depend on someone else's app staying approved or within its quota.

Sign-in uses the **device code** flow (OAuth 2.0 Device Authorization Grant, RFC 8628): the plugin shows a short code and
a web address; you open the address on this or any other device, type the code and allow access. It works the same on
Android and on desktop, without redirect addresses. **Use the same client ID on every device** you sync: Google only
lets an app see the files that app created.

Tokens stay on the device where you signed in (Obsidian's per-device local storage). They are never written into the
vault or the synced plugin settings and never logged. Each device signs in on its own.

---

## Google Drive

### What the plugin can reach

Google allows only a few scopes in the device flow; for Drive these are `drive.file` and `drive.appdata`. The plugin
asks for **`drive.file`**: it can see and change **only the files and folders it created itself**, nothing else in your
Drive. It keeps everything in one folder it creates at the top of My Drive, **`Notebook sync`**. Files you put in that
folder with the Drive website or another app are not visible to the plugin (that is how `drive.file` works).

### 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account whose Drive you want to use.
2. Top bar, project picker, **New project**. Any name (for example *Notebook sync*). **Create**, then select it.

### 2. Turn on the Drive API

1. **APIs & Services > Library**. Search **Google Drive API**, open it, **Enable**.

### 3. Set up the consent screen

1. **APIs & Services > OAuth consent screen** (in newer consoles: **Google Auth Platform > Branding / Audience / Data access**).
2. User type **External** (a personal Gmail account cannot pick Internal). App name: anything; support and developer e-mail: yours.
3. **Scopes / Data access**: add `.../auth/drive.file` ("See, edit, create and delete only the specific Google Drive files you use with this app"). It is a non-sensitive scope.
4. **Audience / Publishing status**: click **Publish app** (*In production*).
   - Why: while an app is in *Testing*, Google expires its refresh tokens after **7 days** and you would have to sign in again every week.
   - With only `drive.file`, publishing needs no review by Google. When you sign in you may see "Google hasn't verified this app": it is your own app; choose **Advanced > Go to (your app name)**.
   - If you prefer to stay in *Testing*, add your own address under **Test users** and expect to sign in again weekly.

### 4. Create the client

1. **APIs & Services > Credentials > Create credentials > OAuth client ID** (or **Clients > Create client**).
2. Application type: **TVs and Limited Input devices**. Any name. **Create**.
3. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**.
   - Google gives a secret to this client type and its token endpoint asks for it. For an app installed on your own
     devices the secret is not confidential in practice (Google says so for installed apps); it still stays on your
     devices only.

### 5. Connect in the plugin

1. **Settings > Notebook > Cloud sync**: provider **Google Drive**, paste the client ID and the client secret, **Connect**.
2. The sign-in dialog shows a code (like `WDJB-MJHT`) and `https://www.google.com/device`. Tap **Open sign-in page** (or
   open the address on your phone or computer), type the code, pick the account and **Allow**.
3. The dialog finishes by itself and creates (or finds) `Notebook sync` in My Drive.

---

## OneDrive

### What the plugin can reach

The plugin asks for `Files.ReadWrite` (your OneDrive), `offline_access` (stay signed in) and `User.Read` (your name and
address for the settings page). It keeps everything in one folder at the top of your OneDrive, **`Notebook sync`**.
Personal Microsoft accounts and work or school accounts both work (a work account may need the organisation's admin to
allow the app).

### 1. Register the app

1. Open <https://entra.microsoft.com/> (or <https://portal.azure.com/>, **Microsoft Entra ID**) with your Microsoft
   account. App registrations live in a Microsoft Entra directory (tenant). If your account has none yet, the portal
   offers to create one (for example through a free Azure account); registering an app costs nothing. Check the
   current Microsoft sign-up terms, which change from time to time.
2. **App registrations > New registration**.
3. Name: anything (for example *Notebook sync*).
4. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**. (The plugin
   signs in through the `common` endpoint, which needs this choice.)
5. Redirect URI: leave empty. **Register**.
6. Copy the **Application (client) ID** from the Overview page.

### 2. Allow the device code flow

1. **Authentication** (or **Authentication > Settings**): **Allow public client flows: Yes**. **Save**.
   - Without this switch Microsoft refuses the device code sign-in.

### 3. Permissions (optional)

The plugin asks for its permissions when you sign in, so nothing is needed here. If you like to list them anyway:
**API permissions > Add a permission > Microsoft Graph > Delegated**: `Files.ReadWrite`, `offline_access`, `User.Read`.
No client secret is needed (and none should be created): this is a public client.

### 4. Connect in the plugin

1. **Settings > Notebook > Cloud sync**: provider **OneDrive**, paste the client ID, **Connect**.
2. The dialog shows a code and `https://microsoft.com/devicelogin`. Open it, type the code, sign in and **Accept**.
3. The dialog finishes by itself and creates (or finds) `Notebook sync` in your OneDrive.

---

## Disconnect

**Disconnect** deletes the tokens from this device. For Google it also revokes them (Google has a revocation endpoint).
Microsoft has no endpoint that revokes one app's token for a public client: to cut access on the account side too, open
<https://account.live.com/consent/Manage> (personal account) or <https://myapps.microsoft.com> (work or school account)
and remove the app. For Google you can also check <https://myaccount.google.com/connections>.

Nothing in your Drive or OneDrive is deleted by disconnecting.

## What the connector never does

- It never deletes a file permanently: a file removed by sync goes to the Google Drive trash or the OneDrive recycle bin.
- It never overwrites a remote file that changed since it last saw it: it reports a conflict instead (see the sync
  settings for how conflicts are kept).
- It never reads or writes outside the `Notebook sync` folder.

## Troubleshooting

| Message | Usual cause |
|---|---|
| *The provider refused the client ID or secret* | A typo in the ID or secret; Google: the client type is not *TVs and Limited Input devices*; Microsoft: *Allow public client flows* is off, or the account type is not "any organizational directory and personal accounts". |
| *Access was not allowed* | You chose Cancel or Deny on the provider's page. |
| *The code expired* | The code is valid for about 15 minutes (Microsoft) or 30 minutes (Google). Try again for a new one. |
| Sign-in needed again after 7 days (Google) | The consent screen is still in *Testing*: publish it (step 3). |
| *The sync folder is missing* | `Notebook sync` was deleted or moved to the trash on the provider's side. Restore it from the trash, or disconnect and connect again to create a new one. |
