# Dank RSS Widget

A desktop widget for [DankMaterialShell](https://github.com/AvengeMedia/DankMaterialShell)
that shows RSS and Atom feeds, fetched directly or synced from Miniflux or any
Google Reader API server.

The [README](https://github.com/BrendonJL/dms-rss-widget) covers installation,
features and the keyboard reference. These pages are the detail behind it.

## Pages

| Page | What it covers |
|---|---|
| [Architecture](Architecture) | How the plugin is structured, the backend interface, and two rules that break things quietly if ignored |
| [Sources and Sync](Sources-and-Sync) | Standard RSS, Miniflux and Google Reader — setup, credentials, and what each server does differently |
| [Notes Export](Notes-Export) | Exporting articles as markdown, full-text extraction, and opening notes in your editor |
| [Data and Persistence](Data-and-Persistence) | Where settings and state live, and how to reset them |
| [Development](Development) | Running the tests, the QML harness, the live server suites, and the extraction oracle |
| [CI](CI) | What runs on a pull request, and why the QML check is `qmlformat` rather than `qmllint` |
| [Roadmap](Roadmap) | What is built, what is planned, and what was deliberately dropped |
| [Related Plugins](Related-Plugins) | Other DMS plugins worth knowing about |

## A note on where these pages live

They are written in `docs/wiki/` in the main repository and pushed here as a
publish step. The wiki is a separate repo with no pull requests and no CI, so
pages edited directly here drift from the code with nothing to catch it.
Editing them in the main repo means a behaviour change and its documentation
land in one reviewable commit.

If you fix something here, please also fix it in `docs/wiki/` — otherwise the
next publish will overwrite it.
