# Sources and Sync

The widget has three source modes. Pick one under **Source** in settings.

| Mode | What it does |
|---|---|
| **RSS** (default) | Fetches the feeds you configure, directly, with `curl` |
| **Miniflux** | Syncs from a [Miniflux](https://miniflux.app/) server over its own API |
| **Google Reader** | Syncs from any server speaking the Google Reader API |

Switching modes never clears read or bookmark history in either direction: ids
are prefixed per source (`m:`, `r:`, `g:`/`l:`/`h:`), so the two sets cannot
collide. See [Data and Persistence](Data-and-Persistence.md).

**Credentials are stored in plaintext** in the plugin's settings, like every
other setting.

## RSS mode

Add feeds by name and URL, or use the quick-add presets (news, tech, Reddit).
OPML import is available; OPML *export* is not yet.

Feeds can be reordered with move-up/move-down buttons. The stored order is what
"grouped by feed" sort follows — grouping is keyed by feed URL rather than
display name, so feeds sharing a name (or with a blank name) still group
correctly, and items from a feed you have since removed sort last. Reordering
closes an open edit form, since a swap would leave it pointing at the wrong
feed.

A disabled feed stays configured and editable but is not fetched.

Each configured feed shows a status line: item count when its last fetch
succeeded, the error or timeout text when it failed, or "Not fetched yet" before
the widget has run. Errors are readable — "Could not resolve host" rather than
"curl exit 6", with the code kept in parentheses for bug reports.

### Fetch hardening

Every `curl` invocation is restricted to http/https on both the initial request
and any redirect (`--proto`/`--proto-redir`), capped at 5 redirects and a 5MB
download, and the response size is re-checked before the body is handed to the
parser. Link opening and thumbnail loading go through a positive http/https
allowlist (`isSafeUrl` in `FeedParser.js`) that fails closed on `javascript:`,
`data:`, control characters and embedded whitespace.

Requests use `--fail-with-body`. Without it, `curl` exits 0 on an HTTP 400 and
the widget — which only reacted to a non-zero exit — discarded every API failure
with no toast, no log line and no other trace.

## Miniflux mode

Enter your server URL and an API token (Miniflux → Settings → API Keys), then
hit **Test Connection**.

Miniflux mode replaces the RSS-only settings sections (Feed Management, OPML
Import, Quick Add) with a Connection section offering server URL and token
fields, **Mark as read on open**, **Show starred entries** (fetch bookmarks
instead of unread), Test Connection / Force Refresh, and a read-only list of
your subscriptions.

Entries flow through the same row UI as RSS items. The mark-read control and the
bookmark icon push read and **starred** state to the server — the bookmark icon
doubles as the star, rather than adding a second control. Bulk actions batch
into one API call each. Every fetch reconciles server state back into local
state, so the server wins after each refresh while local clicks stay instant.

### One gotcha worth knowing

Miniflux types `entry_ids` as `int64`. Sending strings makes the server reject
the whole request with HTTP 400. Starring was never affected, because it puts
the id in the URL path where the type is not checked — which is why the bug
survived a release: half the feature worked.

## Google Reader mode

One protocol rather than one integration each. Verified end to end against
Miniflux and FreshRSS; the same API is served by:

- FreshRSS
- Tiny Tiny RSS (via its Google Reader plugin)
- Inoreader
- TheOldReader
- BazQux
- Miniflux (which serves both its own API and this one)

Enter your server URL, username and password. On Miniflux and FreshRSS these are
the **API credentials from the server's integration settings**, not your web
login — the most common cause of a failed connection test.

Authentication is a two-step chain: ClientLogin for an auth token, then a
request that uses it. `ChainRunner.js` steps the sequence. The Test Connection
button runs the real chain rather than a fake one, so a bad credential fails
there instead of surfacing later as a silently empty feed list.

## Not planned

- **Fever API** — it reaches only backends Google Reader already covers, and is
  read-only in Miniflux.
- **Evernote export** — its local API was retired.

Open to a contributor who wants either.

## See also

- [Architecture](Architecture.md) — how backends are structured
- [Roadmap](Roadmap.md)
