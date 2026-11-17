# Seafile

Connects Bulwark Mail to your Seafile: attach files from your libraries, send
large files as share links, save attachments and messages, and browse your
files on a page of their own.

## Connecting

Open Settings > Plugins > Seafile and choose **Connect Seafile**. The
webmail asks you to confirm the server, then opens Seafile's own sign-in page
in a new tab. Sign in there the way your Seafile is set up, with a password
or through single sign-on, and confirm. Seafile then hands out an access
token, and the webmail server stores it right away. The plugin never sees
it: every request goes through the webmail's plugin proxy, which adds the
token and only talks to that one server.

This is the sign-in Seafile's desktop clients use ("client SSO via local
browser"). The plugin never asks for a Seafile password, so it also works
for accounts that have none.

Seafile gives you five minutes on its page, and its sign-in link works once.
**Open the sign-in page again** therefore starts over with a new link.

Settings then show which Seafile account is connected ("Connected to Seafile
at files.example.com as Alice Example (alice@example.org)"). That is the
account that was signed in on Seafile's page when you connected, which
doesn't have to be your mail account: if someone else was signed in to
Seafile in that browser, their account gets connected. **Use another Seafile
account** disconnects and starts the sign-in again; if Seafile's page still
shows the wrong person, log out there first, and from your organisation's
single sign-on too if Seafile uses one.

**Disconnect** deletes the stored token. Where Seafile gave the webmail a
token of its own (it is then listed in Seafile under Settings > Linked
devices as "Bulwark Mail"), the webmail is also unlinked there, which ends
that token. If the token stops working, because it was unlinked in Seafile
or deleted by an administrator, the plugin says so and offers to sign in
again.

### Single sign-on

With single sign-on (OAuth with Stalwart or another identity provider, or
SAML), the tab that opens takes you through your organisation's sign-in
instead of Seafile's password form. Nothing is set up differently in the
plugin.

Which token the webmail gets depends on how Seafile leads to the sign-in:

- Seafile sends you straight to the identity provider, or you sign in with
  a Seafile password: the webmail gets a token of its own, listed under
  Linked devices, which Disconnect ends. This needs Seafile 14.0.9 or later.
- You press **Single Sign-On** on Seafile's login page, or Seafile is older
  than 14.0.9: the webmail gets your account's general Web API token. It
  works the same, but Seafile hands that token to every app that asks
  without naming a device, so Disconnect only deletes the webmail's copy and
  leaves the token valid in Seafile.

See [For administrators](#for-administrators) for the setting that makes
the first case the rule.

### With an API token

Where a Seafile server doesn't offer the sign-in through the browser,
**Connect with an API token** takes your Web API token instead. You paste it
into the webmail's own dialog, not into the plugin. Seafile shows the token
in your settings under "Web API Auth Token" if the administrator turned that
on. Disconnect deletes the webmail's copy; the token itself stays valid in
Seafile.

Errors are shown in plain words: a token that stopped working (with **Sign
in again** right where it happened), a server without the browser sign-in,
sharing not allowed for your account, a full storage quota, rate limits,
timeouts, and Seafile's own message for things like password rules.

## Libraries

Seafile keeps files in libraries. The plugin starts at the list of your
libraries, your own first, then the ones shared with you (with who shares
them, and "Read-only" where you can't write). Files go into a library, never
next to them, so uploading and saving are offered once a library is open.

Encrypted libraries are listed but can't be opened from the webmail: that
would take the library's password through the plugin.

## Attach from Seafile

In the composer, **Attach > From Seafile** opens a file picker. Browse your
libraries, look at your **Favorites** (what you starred in Seafile) or
search by name, and pick one or more files. Then:

- **Attach copies** downloads the files through the proxy and attaches them
  like any other attachment.
- **Share as link…** creates a public, read-only Seafile link for each file.
  You can protect the links with a password (the plugin suggests one that
  meets Seafile's strictest rules) and set an expiry date. The links go into
  the message where the cursor is, as a short list under "Files shared with
  Seafile". You see them, can edit or delete them like any text, and one
  Ctrl+Z takes them out again. The password is only written into the message
  if you tick **Put the password in the message**; otherwise send it some
  other way.

Search looks in the library you are in. From the list of libraries it looks
at their names and into the first twelve of them.

## Large attachments

When you attach a file of 10 MB or more (adjustable), the plugin asks whether
to upload it to your Seafile and put a share link in the message instead.
The same link options apply. Files larger than 10 MB go up in 10 MB pieces
with a progress bar. **Cancel** pauses the upload; **Resume upload**
continues with what Seafile already has, also after a failed piece. Short
network errors are retried by themselves. **Attach as usual** (or closing
the dialog) attaches the file normally.

Uploads go to the upload folder: by default a library called `Mail
attachments` with a folder per day, made when it is missing. The setting
takes a library, or a folder in one (`My Library/Mail`). A file with the
same name gets a number added.

## Save attachments and messages

Each attachment's menu (the "…" button) has **Save to Seafile**, and the
toolbar of an open message has **Save message to Seafile**, which saves the
whole message as an `.eml` file named after its subject. A folder picker
opens on the folder you used last; **New folder** creates one in place, and
**New library** a library when you are at the list of libraries. Attachments
and messages of up to 25 MB can be saved (the webmail's limit for plugins).

## The Seafile page

**Seafile** in the navigation opens your files in the webmail, laid out like
the Files app. Browse, search and look at your favorites; **Upload** (or
drop files onto the page) with progress, cancel and resume; **New folder**
and **New library**. The account button at the end of the toolbar shows
which Seafile account is connected and lets you use another one. Select a
file to **Download** it, create a **Share link**, **Attach to new message**
(opens the composer with the file attached) or **Open in Seafile**. The
webmail refuses to hand out some file types from a plugin (HTML, SVG,
programs); for those only "Open in Seafile" is offered.

An upload you removed from the list while it was unfinished goes on where it
stopped if you upload the same file to the same folder again within three
days; that is how long Seafile keeps the pieces.

## Settings

User settings (Settings > Plugins > Seafile):

| Setting | Default |
| --- | --- |
| Protect share links with a password | off |
| Share links expire after (days), 0 = never | 14 |
| Offer to send large attachments as a Seafile link | on |
| Large attachment size (MB) | 10 |
| Upload folder (a library, or a folder in one) | Mail attachments |
| Folder layout (`date`: a subfolder per day, `flat`) | date |

## For administrators

| Setting | What it does |
| --- | --- |
| Seafile server (`serverUrl`) | Your organisation's Seafile, e.g. `https://files.example.com`. Users don't have to type it and can only connect to this server. Leave empty to let each user choose. |

### What Seafile needs

Seafile 11 or later, reachable at the root of its address (no `SITE_ROOT`
sub-path).

Turn on the sign-in through the browser in `seahub_settings.py` and restart
Seafile:

```python
CLIENT_SSO_VIA_LOCAL_BROWSER = True
```

Without it the plugin says that the server doesn't offer the sign-in and
leaves users the API token. For that, `ENABLE_GET_AUTH_TOKEN_BY_SESSION =
True` shows users their token in Seafile's settings.

The webmail server must be able to reach Seafile. A Seafile on a private
network has to be listed in `PLUGIN_PROXY_PRIVATE_ORIGINS`, by exact origin.
Seafile needs no CORS setup.

Seafile builds the links it hands out (sign-in page, downloads, uploads,
share links) from its own address settings: `SEAFILE_SERVER_HOSTNAME` and
`SEAFILE_SERVER_PROTOCOL` in Docker setups, `SERVICE_URL` and
`FILE_SERVER_ROOT` otherwise. They must name the address users and the
webmail use, with the file server under `/seafhttp` on that same address.
The proxy only talks to the server the user connected, so a file server on
another host, or on a port other than the connected one, can't be used, and
the plugin says so. A link that names the same host without a port is taken
as meant for the connected address: `http://files.example.com` for a Seafile
behind a TLS proxy at `https://files.example.com`, or a link without the
`:8443` the user connected with.

### Single sign-on (OAuth with Stalwart)

Seafile's OAuth login needs nothing from the plugin: set it up in
`seahub_settings.py` as Seafile's manual describes (`ENABLE_OAUTH`,
`OAUTH_CLIENT_ID`, `OAUTH_AUTHORIZATION_URL`, `OAUTH_TOKEN_URL`,
`OAUTH_USER_INFO_URL`, …). For Stalwart, take the three addresses from its
discovery document at `https://<your-stalwart>/.well-known/openid-configuration`
(`authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`).

By default Seafile shows its login page with a **Single Sign-On** button. To
send users straight to Stalwart instead, add:

```python
LOGIN_URL = '/oauth/login/'
```

Besides saving a click, this gives the webmail a token of its own (see
[Single sign-on](#single-sign-on)): Seafile's login page drops the device
details when the button is used, and then hands out the account's general
token.

Users whose Seafile account is created by the first single sign-on are named
by what the identity provider sends (`OAUTH_ATTRIBUTE_MAP`). The plugin shows
the name and the contact address, never Seafile's internal `…@auth.local`
id.

### Permissions

| Permission | Why |
| --- | --- |
| `http:proxy` | All requests to Seafile go through the webmail's secret proxy with the user's token. |
| `ui:settings-section` | The connect / disconnect section in Settings. |
| `ui:composer-toolbar` | "From Seafile" in the composer's Attach menu (`composer-attach-menu`). |
| `email:blob-write` | Upload a file picked in Seafile to the mail server and attach it to the composer (`api.composer.attach`). |
| `compose:write` | Put the share links into the message at the cursor (`api.composer.replaceSelection`). |
| `email:read` | The "Save to Seafile" entry in the attachment menu (`attachment-menu`) and reading the subject of a message you save. |
| `email:blob-read` | Read a large file you just attached (`upfiles.get`), and an attachment or the message source you save (`email.getAttachment`, `email.getRaw`). |
| `ui:toolbar` | The "Save message to Seafile" button in the reader (`reader-actions`). |
| `ui:app-page` | The Seafile page and its entry in the navigation. |
| `compose:open` | "Attach to new message" on the Seafile page. |
| `ui:download-file` | "Download" on the Seafile page. |

The server address the administrator set is read with `api.config.get()`,
which needs no permission.

`email:blob-write` also covers the `onBeforeBlobUpload` hook, which is how the
large-attachment offer gets in before the file is uploaded to the mail
server.

The `seafile` credential is a user credential sent as `Authorization: Token
…`, the way Seafile's Web API reads it.

## What is sent where

Nothing goes to Seafile until you connect it. The plugin then only sends
what you ask it to: listings and searches while you browse, a share request
for each file you share as a link, the large files you choose to upload,
and the attachments and messages you save.

When you sign in, Seafile is told that the client is called "Bulwark Mail",
so that the webmail can be listed under your linked devices. Seafile only
knows desktop and mobile platforms; the webmail is listed as a Linux client.
The device id is the same for everyone who connects to that Seafile server
and says nothing about you.

If you connect the same Seafile account from two mailboxes or two webmails,
Seafile gives both the same token. Disconnecting one unlinks it, and the
other has to sign in again.

## Development

```
node seafile/scripts/sync-locales.mjs     # copy locales/*.json into manifest.json
node scripts/build.mjs seafile            # build seafile.zip
node node_modules/vitest/vitest.mjs run seafile
BULWARK_ADMIN_PASSWORD=... node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.mjs seafile/e2e
```

Translations live in `locales/<lang>.json`, one file per webmail language.
The unit tests run against a small Seafile in `test/fake-seafile.mjs`, which
answers the way Seafile 14 was seen to. The end-to-end tests run against the
Seafile container from `test-env` (user alice).
