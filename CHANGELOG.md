# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The wire protocol has its own version (`PROTOCOL_VERSION` in
`src/shared/protocol.ts`); a change to it is always called out here.

## [1.0.0] — Unreleased

First public release. Protocol version 1.

### Added

- Quarto extension `live-poll`: a Lua filter and a revealjs plugin, enabled
  under both `filters` and `revealjs-plugins`.
- `.poll` divs: a bullet list becomes a live bar chart. Task-list syntax
  (`- [x]`) marks correct answers; `A` reveals them and closes voting.
- `.wordcloud` divs: short free-text answers shown as a live word cloud, with
  `max-words` and `max-answers` per question, answer normalization, stable
  word positions, and click-to-hide moderation for the presenter.
- Per-question `#id`, `prompt=` and `results=` attributes, and `live-poll:`
  options `server`, `session`, `close-on-leave`, `results` and `qr`.
- One audience URL per session that follows the deck, shown as a QR code and
  short URL on question slides, and full screen with `Q`.
- Presenter key passed once with `?presenter=` and kept in `localStorage`;
  viewers see results without control; the speaker view and other iframes
  never take control. `?session=` overrides the session for rehearsals.
- `T` toggles results on the slide (`results: hidden` workflow); hover
  controls to close, reopen and reset a question.
- Static rendering without a server, in `?print-pdf`, and in non-HTML
  formats.
- Mobile voting page with light and dark themes, reconnect with backoff, and
  no third-party requests.
- Server with a pure `Room` core, a shared connection `Hub` and Hono routes,
  running as a Cloudflare Worker with one SQLite-backed Durable Object per
  session (WebSocket hibernation), or as a Node server in Docker with
  per-session JSON files.
- `/healthz`, a key-protected JSON export per session, a protocol smoke test
  (`scripts/smoke.ts`) and a presenter CLI (`scripts/presenter.ts`).
- CI: type check, unit tests, bundle freshness check, Node smoke test, Worker
  dry-run bundle, Quarto render and Docker build with a smoke test.

[1.0.0]: https://github.com/seandavi/quarto-live-poll/releases/tag/v1.0.0
