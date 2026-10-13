# Live Poll: specification

Live audience questions for Quarto revealjs decks. Multiple-choice questions
render as a live bar chart; short-answer questions render as a live word
cloud. When the presenter reaches a question slide, the question opens, a QR
code points the audience at a voting page, and results update in real time.

The backend runs on Cloudflare (Worker + Durable Object) or as a Docker
container (Node). Both run the same core.

The wire protocol is defined in [`src/shared/protocol.ts`](src/shared/protocol.ts).
That file is the source of truth for message shapes and limits. This document
covers behavior and the decisions behind it.

## Architecture

```
presenter deck (Quarto revealjs)               audience phones
 live-poll.lua   markup -> question JSON        /s/<session>  voting page
 live-poll.js    slide change -> open question,      |
                 QR code, live bars / word cloud     | WebSocket
       | WebSocket                                   |
       +------------> one room per session <---------+
                      Cloudflare: Worker + Durable Object (SQLite storage)
                      Docker:     Node + @hono/node-ws
                      both:       Room core (src/server/room.ts) + Hono routes
```

- **Room core** (`src/server/room.ts`): pure TypeScript, no I/O. It holds a
  session's questions, votes and answers. It applies client messages, produces
  the `deck`, `audience` and `you` payloads, and serializes itself for
  storage. Every behavior rule below lives here and is unit-tested here.
- **Routes** (`src/server/app.ts`): one Hono app shared by both runtimes. Each
  runtime injects its own WebSocket handler and static-file serving.
- **Adapters**: `src/server/cloudflare/` (Worker + `SessionRoom` Durable
  Object) and `src/server/node/` (HTTP server, room registry, file
  persistence). They hold connections, check the presenter key, rate-limit,
  coalesce broadcasts and persist the room. They contain no question logic.
- **Deck plugin** (`src/deck/` built to `_extensions/live-poll/live-poll.js`)
  and **Lua filter** (`_extensions/live-poll/live-poll.lua`).
- **Audience page** (`public/*.html`, `public/vote.css`, `src/audience/`
  built to `public/vote.js`).

## Repository layout

```
_extensions/live-poll/     what `quarto add` installs; live-poll.js is a
                           committed build artifact
src/shared/protocol.ts     wire protocol and limits
src/server/                room core, validation, rate limiting, Hono app
src/server/cloudflare/     Worker entry and Durable Object
src/server/node/           Node entry (Docker)
src/deck/                  deck plugin source
src/audience/              audience page source
public/                    audience page static files (vote.js is built)
scripts/smoke.ts           protocol smoke test against a running server
example.qmd                demo deck
wrangler.jsonc, Dockerfile, compose.yaml, justfile
```

## Authoring

### Enabling the extension

```yaml
# _quarto.yml or document front matter
format: revealjs
filters:
  - live-poll
revealjs-plugins:
  - live-poll
live-poll:
  server: https://questions.example.workers.dev  # omit for static rendering
  session: idpt-8079-2026-10-13
```

### Configuration (`live-poll:` metadata)

| Key | Default | Meaning |
|---|---|---|
| `server` | none | Server origin. Without it the deck renders questions statically. |
| `session` | input file name, sanitized | Room name. A new name starts with empty results. Must match `LIMITS.sessionPattern`. |
| `close-on-leave` | `true` | Close the live question when the presenter navigates off its slide. |
| `results` | `live` | `live` shows results on the slide as votes arrive; `hidden` waits until the presenter shows them. |
| `qr` | `true` | Show the QR code and short URL on question slides. |

At presentation time, `?session=<name>` in the deck URL overrides `session`
(for example to rehearse without polluting the real session).

### Multiple choice (bar chart)

```markdown
## Which language do you use most?

::: {.poll #lang}
- R
- Python
- Julia
:::
```

To mark correct answers, use task-list syntax. A question with at least one
`[x]` is a quiz; the presenter reveals the answer with a key press.

```markdown
::: {.poll #capital}
- [ ] Sydney
- [x] Canberra
- [ ] Melbourne
:::
```

### Short answer (word cloud)

```markdown
## One word for today's lecture?

::: {.wordcloud #mood max-words=2 max-answers=3}
:::
```

### Question attributes

| Attribute | Applies to | Default | Meaning |
|---|---|---|---|
| `#id` | both | `q-` + first 10 hex digits of SHA-1 of prompt and options | Question id on the server. Give one explicitly: editing the question changes a generated id, and its old results stay behind under the old id. |
| `prompt="..."` | both | see below | Overrides the prompt text sent to phones. |
| `results=` | both | config `results` | Per-question override. |
| `max-words=` | wordcloud | 3 | Words kept per answer. |
| `max-answers=` | wordcloud | 3 | Answers per person. |

The prompt sent to phones is, in order: the `prompt` attribute; else any
non-list text inside the div; else the text of the nearest preceding heading.

### Lua filter

- Runs only for revealjs output. For any other format the div is left as a
  plain list.
- Replaces each `.poll` / `.wordcloud` div with a container
  `div.lp-question.lp-poll` (or `.lp-wordcloud`) carrying the same id and a
  `data-lp` JSON attribute: the `Question` definition plus `correct` (option
  indices, poll only, omitted if none) and `results`. Inside it keeps the
  original list, with task-list markers stripped, as the static fallback and
  as the source of the option labels' HTML.
- Writes the resolved config as JSON into
  `<script type="application/json" id="lp-config">` (in the document head).
- Warns (via `quarto.log.warning`) about duplicate ids, polls with fewer than
  two options, and values outside `LIMITS`. Out-of-range `max-words` /
  `max-answers` are clamped; over-long prompts and options are truncated.

As built, for example:

```html
<div id="capital" class="lp-question lp-poll"
     data-lp='{"type":"poll","id":"capital","prompt":"What is the capital of Australia?",
               "options":["Sydney","Canberra","Melbourne","Perth"],"correct":[1],"results":"live"}'>
  <div class="lp-text">…non-list content of the div, if any…</div>
  <ul><li>Sydney</li><li>Canberra</li>…</ul>
</div>
<div id="mood" class="lp-question lp-wordcloud"
     data-lp='{"type":"wordcloud","id":"mood","prompt":"One word for today’s lecture?",
               "maxWords":2,"maxAnswers":3,"results":"live"}'></div>

<script type="application/json" id="lp-config">
{"server":"http://localhost:8787","session":"example","closeOnLeave":true,"results":"live","qr":true}
</script>
```

- `correct` holds 0-based option indices. `server` is omitted when not
  configured (trailing slashes are stripped).
- The generated id is `q-` + the first 10 hex digits of
  `sha1(prompt .. "\n" .. options joined by "\n")`.
- The default session is the input file stem with characters outside
  `[A-Za-z0-9_-]` replaced by `-` (runs collapsed, leading and trailing `-`
  dropped, cut to 64 characters).
- One extension contributes both the filter and the plugin; a document lists
  it under both `filters: [live-poll]` and `revealjs-plugins: [live-poll]`
  (verified with Quarto 1.9).

## Presenting

### Presenter key

The server has one secret, `PRESENTER_KEY`. Open the deck once with
`?presenter=<key>`. The plugin stores the key in `localStorage` (per server
origin), removes it from the address bar, and sends it in `hello`.
`?presenter=` (empty) forgets it. The key never appears in the rendered HTML
or in git, so a deck published on the web is safe to share: anyone else who
opens it is a viewer.

### Deck modes

| Mode | When | Behavior |
|---|---|---|
| static | no `server`, `?print-pdf`, or non-HTML output | Question and options only. No QR, no socket. |
| viewer | server configured, no key or key rejected | QR, live results, no control. |
| presenter | key accepted (`welcome.presenter`) | Opens and closes questions, and handles the keys and controls below. |
| embedded | inside an iframe or with the `receiver` URL parameter (reveal speaker view) | Behaves as a viewer even if a key is stored, so the speaker view's next-slide preview never opens the next question. |

### Lifecycle (presenter mode)

- On `ready` and on every `slidechanged`: if the current slide contains a
  question, send `open` with its definition. If it does not, and the previous
  slide's question is live and `close-on-leave` is on, send `close`.
- Only one question is live at a time; opening one closes the previous one on
  the server.
- `open` is idempotent. Reloading the deck or revisiting a slide keeps
  existing votes, as long as the question's definition has not changed.
- After a reconnect, the presenter re-sends `open` for the current slide's
  question so the server matches the deck. It waits for the first `deck`
  state and skips the `open` if the server already has that question live
  with the same definition, so a question the presenter closed stays closed
  through a network blip. Likewise, if the presenter is on a slide without a
  question and the last question it opened is still open, it sends `close`.
- If a slide holds more than one question, the first one is the one opened.

### Keys and controls

| Key | Action |
|---|---|
| `Q` | Toggle a full-screen QR overlay ("everyone scan this"). |
| `A` | Reveal the correct answer of the current poll (also closes voting). |
| `T` | Toggle results visibility on the current slide (the `results: hidden` workflow). |

Reveal and Quarto already use H/J/K/L, N, P, B, V, F, O, S, G, M, E, R and
`?`, and chalkboard uses C, D, X and Y, so those keys are avoided. Bindings
are registered with `deck.addKeyBinding` so they show up in the `?` help
overlay. In presenter mode only, a small control strip on the question
(visible on hover or keyboard focus) offers close/reopen voting and reset
(reset asks for confirmation first). Reopen sends `open` again.

- `Q` works on any slide and in every live mode; `Escape`, a click, or
  changing slide closes the overlay.
- `T` is local to the deck it is pressed in (there is no protocol message
  for it). Results also become visible once a poll's answer is revealed.
- `A` in a viewer deck only shows a "presenter only" toast.

### What the slide shows

A grid: results on the left, and on the right the QR code (encoding
`<server>/s/<session>`), the short URL as text, a response count, and a status
pill (`LIVE`, `CLOSED`, `OFFLINE`). Colors come from the reveal theme's CSS
variables (`--r-main-color`, `--r-link-color`, `--r-background-color` and so
on), so the component works on light and dark themes.

- The component takes the slide height left below it (it is sized when its
  slide is shown), and the bar chart shrinks its text, down to 60%, until
  every option fits.
- **Bar chart**: horizontal bars, one per option. The label HTML is taken
  from the original list item; each bar shows its count and percentage, and
  bar widths animate. Widths are relative to the leading option (the
  percentage is of all votes). After a reveal, correct options are
  highlighted and the others dimmed.
- **Word cloud**: a spiral layout with each word's position remembered. A
  word keeps its place as counts grow and moves only if it starts to collide,
  so the cloud never reshuffles. Font size scales with the square root of
  `count / maxCount`, so sizes hold steady as counts grow in proportion; all
  fonts shrink together (never below 60%) when the cloud gets crowded, and
  the least frequent words are left out if even that does not fit. The
  layout is per deck, so two decks can arrange the same words differently.
  In presenter
  mode, clicking a word hides it (moderation). Hidden words are listed in a
  presenter-only tray, where clicking one restores it.

The QR code comes from `qrcode-generator`, bundled into `live-poll.js`; there
are no CDN requests.

## Audience page

- `/s/<session>`, mobile first, light or dark from `prefers-color-scheme`, no
  external requests. `/` shows a "join a session" form.
- The voter id is a random UUID stored in `localStorage` (`lp:voter`), with an
  in-memory fallback.
- States: connecting; waiting for a question; poll open (large option buttons,
  current choice highlighted, the vote can be changed while open); word cloud
  open (text input, the voter's submitted answers as chips, answers remaining);
  closed (results as bars or a ranked word list, correct options highlighted
  if revealed); offline (auto-reconnect with backoff).
- Follows the deck: phones switch to whatever question is live, so the
  audience scans once per talk.
- All server-provided text is rendered with `textContent`, never `innerHTML`.

## Server

### Routes (shared Hono app)

| Route | Response |
|---|---|
| `GET /healthz` | `ok` |
| `GET /` | landing / join page |
| `GET /s/:session` | audience page (404 if the session name is invalid) |
| `GET /api/s/:session/ws` | WebSocket upgrade |
| `GET /api/s/:session/export` | full room JSON including hidden words; requires `Authorization: Bearer <PRESENTER_KEY>` |

### Connection handling (adapters)

- The first message must be `hello` with `v === PROTOCOL_VERSION`. The socket
  is a presenter only if `role === "deck"` and `key` matches `PRESENTER_KEY`
  (constant-time compare). If `PRESENTER_KEY` is unset, nobody is a presenter
  and the server logs a warning.
- Maximum message size: 4 KB from audience sockets, 32 KB from deck sockets.
  Larger messages get a `bad-message` error.
- Rate limit per audience socket: token bucket, burst 20, refill 5 per second.
  Excess messages are dropped with a `limit` error. The limiter is pure
  (`now` passed in) and shared by both adapters.
- Heartbeat: clients send exactly the string `{"t":"ping"}` every 25 s; the
  server answers exactly `{"t":"pong"}`. On Cloudflare this is
  `setWebSocketAutoResponse`, so pings never wake a hibernated Durable Object.
- Broadcasts are coalesced to at most one `deck` and one `audience` broadcast
  per session every 200 ms. `deck` and `audience` payloads are serialized once
  per broadcast (the presenter variant, which includes hidden words,
  separately). `you` is sent right away, only to the voter's own sockets.
- Persistence is written in the same flush as the broadcast: on Cloudflare,
  `ctx.storage.put("room", room.dump())`; on Node,
  `$DATA_DIR/<session>.json`, written atomically (temp file and rename) and
  loaded the first time the session is used.

### Room rules

- `open`: insert or replace the definition. If the stored definition differs
  in any field, clear that question's votes, answers, reveal and hidden set.
  Set status `open` and `live = id`. A previously live question becomes
  `closed`.
- `close`: status `closed`. `live` still points at the question, so phones
  show its results.
- `reveal`: polls only, with indices in range. Stores `revealed` and closes
  the question.
- `reset {id}`: clear that question's votes, answers, reveal and hidden set;
  status is unchanged. `reset {}`: drop all questions and set `live = null`.
- `hide`: word clouds only. Normalizes `text` and adds it to or removes it
  from the hidden set.
- `vote`: requires `id === live` and status `open`, and `choice` must be an
  integer in range. Last vote wins.
- `answer`: requires `id === live` and status `open`. The text is normalized
  (below); an empty result is `bad-message`. Re-submitting an answer the voter
  already gave is a no-op. A new answer beyond `maxAnswers` is `limit`.
- A word cloud's word count is the number of distinct voters who submitted
  that normalized answer. `voters` counts distinct voters with at least one
  vote or answer.
- `AudienceState.live.results` is `null` while the question is open.

### Answer normalization

1. Unicode NFKC, control characters removed, whitespace collapsed, trimmed.
2. Strip leading and trailing `. , ; : ! ? " ' ( ) [ ] { } …` and curly
   quotes. Symbols such as `+` and `#` are kept (`C++`, `C#`).
3. Keep the first `maxWords` whitespace-separated words, then cut to
   `LIMITS.answerChars` characters.
4. The matching key is the lowercased result. The display text is the first
   spelling the room saw.

## Deployment

### Cloudflare

- `wrangler.jsonc`: Worker entry `src/server/cloudflare/worker.ts`, Durable
  Object class `SessionRoom` bound as `ROOMS` with a `new_sqlite_classes`
  migration (SQLite-backed Durable Objects are available on the free plan),
  static assets from `public/`, and a build step that bundles `public/vote.js`.
- Each session is `ROOMS.idFromName(session)`. The Worker forwards the
  WebSocket upgrade to the Durable Object, which accepts it with the
  hibernation API (`ctx.acceptWebSocket`), tags sockets by role and voter, and
  keeps per-socket state in `serializeAttachment`.
- Secret: `wrangler secret put PRESENTER_KEY`. For local dev, `.dev.vars`
  (gitignored; see `.dev.vars.example`).

### Docker

- Multi-stage: Bun builds `dist/server.js` and `public/vote.js`; the runtime
  image is `node:24-slim`, running as the `node` user, with a `/healthz`
  `HEALTHCHECK`.
- Environment: `PORT` (default 8787), `PRESENTER_KEY`, `DATA_DIR` (default
  `/data`, mount a volume).
- `compose.yaml` shows the volume and the `.env` file for the key, with
  Traefik labels as a commented example.

## Testing

- **Unit**: `bun test`. Covers the room rules, normalization, validation and
  the rate limiter.
- **Smoke**: `bun scripts/smoke.ts <base-url> <key>` drives a presenter and
  several audience sockets through a poll (votes, vote change, close,
  rejected late vote, reveal) and a word cloud (normalization, duplicates,
  limit, hide), and checks that export requires the key. It runs against the
  Node server, `wrangler dev` and the Docker image.
- **Deck**: render `example.qmd` and screenshot static mode with Playwright.
- **End to end**: a local server plus the rendered deck as presenter and the
  audience page in a phone viewport. Vote, then check that the slide's bars
  and word cloud update and that the QR code encodes the audience URL.

## Security model and known limits

- Voter ids are generated by the client, so one person can vote again from a
  private window or with a script. That's acceptable for a classroom or talk
  audience; per-IP limits are possible later.
- Correct answers are embedded in the deck HTML (`data-lp`), so a determined
  viewer of the deck source can see them.
- One presenter key per server, shared by all sessions on it.
- Input is validated server-side against `LIMITS`, and audience text only
  ever reaches the DOM via `textContent`. Option labels are the deck author's
  own HTML, which the author already trusts.

## Decisions

| Decision | Why |
|---|---|
| TypeScript server rather than FastAPI | Durable Objects run JavaScript, and the deck and audience page are JavaScript too. One language lets all three share `protocol.ts` and get type checking across the boundary. |
| Durable Object per session | Serverless functions (Vercel, Netlify) can't keep WebSockets open, so similar projects add Pusher or Ably, or poll. A Durable Object holds the sockets and the state in one place, hibernates when idle, and fits in the free plan. |
| Room core with no I/O, plus two thin adapters | Every behavior rule is tested once and shared. The adapters only move bytes. This was preferred over running `workerd` inside Docker, which would be a single codebase but harder to operate and debug. |
| Hono for routing only | It lets one route table run on Workers and on Node. WebSockets stay runtime-specific because Hono's Cloudflare WebSocket helper bypasses the Durable Object hibernation API. |
| Session URL that follows the deck | The audience scans once per talk. A per-question QR code would make everyone rescan for every question. |
| Presenter key passed in the URL and kept in `localStorage`, never in the HTML | A published deck is safe to share, and only the presenter's browser controls questions. |
| Lua filter parses the markup | The plugin JS never reads markdown, and PDF and other non-HTML renders degrade to a plain list. |
| Task-list `[x]` marks correct answers | It's native Pandoc syntax that reads naturally in source. A plain list means a poll with no right answer. |
| Results hidden from phones while voting is open | Avoids bandwagon voting. The projected slide can also hide them (`results: hidden`). |
| QR library bundled, no CDN | Decks work on venue Wi-Fi with captive portals or blocked CDNs, and the only network dependency is the server itself. |

## Out of scope for v1

CSV export, multi-select polls, profanity filtering, per-IP rate limits,
automatic session expiry, multiple presenter keys or accounts, and a results
archive page.
