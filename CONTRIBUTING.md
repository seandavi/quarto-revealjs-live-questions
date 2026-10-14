# Contributing

Thanks for helping. Bug reports, small fixes, documentation and design
discussions are all welcome. For anything larger than a bug fix, please open
an issue first so we can agree on the approach before you write the code.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security problems privately as described in [SECURITY.md](SECURITY.md),
not in a public issue.

## Setup

You need:

- [Bun](https://bun.sh) 1.3 or later (package manager, bundler, test runner)
- [Quarto](https://quarto.org) 1.9 or later (tested with 1.9 and 1.10)
- [just](https://github.com/casey/just) (optional; every recipe is a short
  command you can run by hand)
- Node.js 22 or later for Wrangler (the built Node server itself runs on
  Node 20 or later; the Docker image uses Node 24)
- Docker, only if you work on the container

```bash
bun install
just build        # deck bundle, phone page bundle, Node server
just typecheck
just test
```

To try a change end to end:

```bash
just dev-node                     # Node server on :8787, presenter key "dev"
just preview                      # quarto preview example.qmd
```

Open the preview with `?presenter=dev`, and open
`http://localhost:8787/s/example` in a narrow browser window (or on a phone
on the same network, using your machine's LAN address) to vote.
`bun scripts/presenter.ts` can play presenter or simulate many phones without
a deck; run it without arguments for usage.

## Repository layout

```
_extensions/live-questions/     what `quarto add` installs
  live-questions.lua            Lua filter: markup -> question JSON
  live-questions.js             deck plugin bundle (built from src/deck/, committed)
  live-questions.css            slide styles
src/shared/                wire protocol (protocol.ts) and answer normalization
src/server/room.ts         Room core: all voting rules, no I/O
src/server/hub.ts          connection handling shared by both runtimes
src/server/app.ts          HTTP routes (Hono), shared by both runtimes
src/server/cloudflare/     Worker entry and SessionRoom Durable Object
src/server/node/           Node entry used by the Docker image
src/deck/                  deck plugin source
src/audience/              phone page source
public/                    phone page HTML and CSS (vote.js is built)
scripts/                   smoke test and presenter CLI
example.qmd                demo deck
```

[SPEC.md](SPEC.md) is the behavior reference, and records why things are the
way they are. Read the relevant section before changing behavior.

## Where a change belongs

The code is split into a few deep modules with small interfaces. Most
changes touch one of them.

| You want to change | Change it in | Tests |
|---|---|---|
| What a vote, answer, open, close, reveal, reset or hide does; what deck and phones are told | `src/server/room.ts` (the Room core) | `room.test.ts` |
| Message validation or limits | `src/server/validate.ts`, `LIMITS` in `src/shared/protocol.ts` | `validate.test.ts` |
| Answer normalization (deck, phone and server share it) | `src/shared/normalize.ts` | `normalize.test.ts` |
| Handshake, presenter check, size limits, rate limiting, broadcast coalescing, when state is persisted | `src/server/hub.ts` (the Hub) | `hub.test.ts`, `ratelimit.test.ts` |
| Routes, headers, the export endpoint | `src/server/app.ts` | smoke test |
| How sockets are held or state is stored on one runtime | `src/server/cloudflare/worker.ts` or `src/server/node/main.ts` (the adapters) | smoke test against that runtime |
| Markup, attributes, config keys, render-time warnings | `_extensions/live-questions/live-questions.lua` | render `example.qmd` |
| What the slide shows, keys, presenter lifecycle | `src/deck/` | `cloud-layout.test.ts`, manual deck check |
| The phone page | `src/audience/vote.ts`, `public/` | manual check in a phone-sized window |

Two rules keep this manageable:

- **The adapters contain no question logic.** If Cloudflare and Node would
  both need the same change, it belongs in the Room or the Hub, where it is
  written and tested once. An adapter only lists sockets, sends frames,
  stores per-socket info and persists the room (the `HubHost` interface).
- **The Room core does no I/O.** It takes messages and returns outcomes and
  payloads, and serializes itself with `dump()` / `restore()`. That is what
  makes it unit-testable without sockets or timers.

## The committed bundle

`_extensions/live-questions/live-questions.js` is checked in, because `quarto add`
installs the `_extensions/` folder as it is in the repository. After changing
anything under `src/deck/` or `src/shared/`:

```bash
bun run build:deck
git add _extensions/live-questions/live-questions.js
```

CI rebuilds the bundle and fails if it differs from the committed file. CI
builds with the Bun release pinned as `BUN_VERSION` in
`.github/workflows/ci.yml`; if your Bun produces a different file, build with
that release (`bunx bun@<version> run build:deck`), or update the pin in the
same pull request. Do not edit `live-questions.js` by hand. `public/vote.js` and `dist/` are build
output and are not committed.

## Tests

- **Unit**: `bun test`. Room rules, validation, normalization, the rate
  limiter, the Hub and the word-cloud layout. New behavior in the Room or Hub
  needs a test there.
- **Type check**: `bun run typecheck`. It checks the browser, Node and shared
  code with `tsconfig.json`, and the Worker with `tsconfig.worker.json`
  (Workers types conflict with the DOM lib, so they are separate).
- **Smoke**: `bun scripts/smoke.ts <base-url> <key>` (or `just smoke`) drives a
  presenter and several phones through a poll and a word cloud against a
  running server. Run it against the Node server for any server change, and
  against `bunx wrangler dev` (`just dev-cf`) if you touched the Worker.
- **Worker bundle**: `bunx wrangler deploy --dry-run --outdir /tmp/lq-worker`
  checks that the Worker bundles. It needs no Cloudflare account.
- **Deck**: render `example.qmd` and check it as presenter, viewer and static
  (`?print-pdf`), on a light and a dark theme, with a phone-sized window
  voting. Mention what you checked in the pull request.

CI runs the type check, unit tests, the bundle check, the Node smoke test,
the Worker dry run, a Quarto render of `example.qmd` and a Docker build with
a smoke test against the container. Once all of those pass, it builds the
image for linux/amd64 and linux/arm64. On pull requests it stops there; on a
push to `main` or a `v*` tag it pushes the image to
`ghcr.io/seandavi/quarto-revealjs-live-questions`, tagged as listed in the
README's Docker section. A release tag (`v1.2.0`) is what moves `latest`.

## Commits and pull requests

- Work on a branch, never on `main`.
- Prefer several small commits, each doing one thing, over one large one.
  Write the subject in the imperative ("Add ...", "Fix ..."), under about 70
  characters, and use the body to say why.
- Keep pull requests focused. Fill in the template: what changed, why, and
  how you tested it. Include a screenshot for visible changes.
- Update the docs in the same pull request: README.md for anything a user
  sees, SPEC.md for behavior, and CHANGELOG.md under "Unreleased".
- CI must pass. If you changed `src/deck/`, the rebuilt bundle must be in the
  pull request.

## Changing the protocol

The deck, the phone page and the server are deployed separately. A speaker
may update the extension in a deck long before updating their server, and
phones may have an old page open. So protocol changes need care.

1. Change `src/shared/protocol.ts` and the "Server" section of `SPEC.md` in
   the same pull request. `protocol.ts` is the source of truth for message
   shapes and limits; SPEC.md explains behavior.
2. Decide whether the change is compatible:
   - **Compatible** (no version bump): adding an optional field that old
     peers can ignore, or loosening a limit. The server already drops fields
     it does not know, and the deck and phone page ignore message types they
     do not know. Check both directions: an old deck against a new server, and
     a new deck against an old server.
   - **Incompatible** (bump `PROTOCOL_VERSION`): removing or renaming a
     message or field, changing what an existing message means, adding a
     client message that an old server would reject, or tightening a limit
     that old clients could exceed.
   - **In between**: a new question type. An old server rejects `open` for it
     with `bad-message` (the deck shows a toast) while every other question
     keeps working, so a bump is not required, but CHANGELOG.md must say that
     using it needs an updated server.
3. A bump is disruptive: the server refuses `hello` from any other version
   (error `version`, close code 4000), decks stop reconnecting, and phones
   show "This page is out of date". Every deployed server and every deck's
   extension must be updated together. Say so in CHANGELOG.md, and prefer a
   compatible design when one exists.
4. Update `scripts/smoke.ts` to cover the new behavior.
