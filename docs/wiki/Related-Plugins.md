# Related Plugins

## Dank News RSS & Ticker

[**Dank News RSS & Ticker**](https://github.com/Xn4m3d/dms-rss-widget) by
[@Xn4m3d](https://github.com/Xn4m3d) takes the same feeds in a different
direction: a full-width scrolling headline bar that docks under the DankBar or
follows a bottom bar, plus an optional companion pill that shows the same
headlines inside the bar itself.

It is registered separately, as `dankNewsRssTicker` and
`dankNewsRssTickerPill`, so it installs alongside this plugin rather than
replacing it.

Rough guide: if you want a desktop card you sit down and read, use this one. If
you want headlines scrolling past while you work, use theirs.

## Shared ancestry

The two share ancestry and fixes flow between them. These came here from
@Xn4m3d:

- [#1](https://github.com/BrendonJL/dms-rss-widget/pull/1) — security hardening
  (curl protocol/redirect/response-size limits) and the overlapping-fetch fix
- [#2](https://github.com/BrendonJL/dms-rss-widget/pull/2) — loading state
  instead of a blank flash when the widget is recreated on resize
- [#3](https://github.com/BrendonJL/dms-rss-widget/pull/3) — the niri overview
  click guard, so clicking a workspace thumbnail positioned over the widget
  cannot land on it
- [#5](https://github.com/BrendonJL/dms-rss-widget/pull/5) — further hardening

…as did the parser bugs fixed in 2.3.1 and 2.3.2
([#7](https://github.com/BrendonJL/dms-rss-widget/issues/7)).

Miniflux source mode came from
[@alexanderi96](https://github.com/alexanderi96) in
[#6](https://github.com/BrendonJL/dms-rss-widget/pull/6), ported onto the stable
item ID scheme and the existing persisted read/bookmark store.
