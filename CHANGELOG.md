# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The wire protocol has its own version (`PROTOCOL_VERSION` in
`src/shared/protocol.ts`); a change to it is always called out here.

## [1.1.1] — 2026-10-14

The first release with a published Docker image. The extension, the phone
page and the protocol are unchanged from 1.1.0.

### Added

- The server image is published to
  `ghcr.io/seandavi/quarto-revealjs-live-questions` for linux/amd64 and
  linux/arm64. Each release gets its version, minor, major and `latest` tags,
  `main` gets a `main` tag, and every push also gets a `sha-<commit>` tag.

### Changed

- `compose.yaml` runs the published image instead of building from a checkout
  (`build: .` stays as a commented-out option).

## [1.1.0] — 2026-10-13

### Added

- [Quarto Wizard](https://m.canouil.dev/quarto-wizard/) support: a
  `_schema.yml` describing the deck options, the `.poll`, `.wordcloud` and
  `.likert` classes and their attributes, and a `_snippets.json` with
  front-matter, poll, quiz, word cloud and rating-scale snippets.
- Deck options can also be set under `extensions: live-questions:`, the form
  Quarto Wizard completes. A key set under top-level `live-questions:` takes
  precedence.
- README sections on editor support and on writing questions with an AI
  assistant, pointing it at `SPEC.md`, `_schema.yml` and `example.qmd`.

### Fixed

- A non-map `live-questions:` value, such as `live-questions: oops`, now warns
  at render time instead of being silently ignored.

## [1.0.0] — 2026-10-13

First public release. Protocol version 1.

### Added

- Quarto extension `live-questions`: a Lua filter and a revealjs plugin, enabled
  under both `filters` and `revealjs-plugins`.
- `.poll` divs: a bullet list becomes a live bar chart. Task-list syntax
  (`- [x]`) marks correct answers; `A` reveals them and closes voting.
- `.wordcloud` divs: short free-text answers shown as a live word cloud, with
  `max-words` and `max-answers` per question, answer normalization, stable
  word positions, and click-to-hide moderation for the presenter.
- `.likert` divs: one to six statements rated on a shared scale (`agree-5`,
  `agree-7`, numeric ranges such as `0-10` with `low=`/`high=` end labels, or
  custom `labels=`), shown as diverging bars or histograms with mean and
  median; phones rate each statement and can change ratings while open.
- Per-question `#id`, `prompt=` and `results=` attributes, and `live-questions:`
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

[1.1.1]: https://github.com/seandavi/quarto-revealjs-live-questions/releases/tag/v1.1.1
[1.1.0]: https://github.com/seandavi/quarto-revealjs-live-questions/releases/tag/v1.1.0
[1.0.0]: https://github.com/seandavi/quarto-revealjs-live-questions/releases/tag/v1.0.0
