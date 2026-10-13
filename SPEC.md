# Live Questions: specification

Live audience questions for Quarto revealjs decks. Multiple-choice questions
render as a live bar chart; short-answer questions render as a live word
cloud; rating-scale (likert) questions render as diverging stacked bars or,
for numeric scales, small histograms. When the presenter reaches a question slide, the question opens, a QR
code points the audience at a voting page, and results update in real time.

The backend runs on Cloudflare (Worker + Durable Object) or as a Docker
container (Node). Both run the same core.

The wire protocol is defined in [`src/shared/protocol.ts`](src/shared/protocol.ts).
That file is the source of truth for message shapes and limits. This document
covers behavior and the decisions behind it.

## Architecture

```
presenter deck (Quarto revealjs)               audience phones
 live-questions.lua   markup -> question JSON        /s/<session>  voting page
 live-questions.js    slide change -> open question,      |
                 QR code, live bars / cloud / likert | WebSocket
       | WebSocket                                   |
       +------------> one room per session <---------+
                      Cloudflare: Worker + Durable Object (SQLite storage)
                      Docker:     Node + @hono/node-server (built-in WebSockets via ws)
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
- **Deck plugin** (`src/deck/` built to `_extensions/live-questions/live-questions.js`)
  and **Lua filter** (`_extensions/live-questions/live-questions.lua`).
- **Audience page** (`public/*.html`, `public/vote.css`, `src/audience/`
  built to `public/vote.js`).

## Repository layout

```
_extensions/live-questions/     what `quarto add` installs; live-questions.js is a
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
  - live-questions
revealjs-plugins:
  - live-questions
live-questions:
  server: https://questions.example.workers.dev  # omit for static rendering
  session: idpt-8079-2026-10-13
```

### Configuration (`live-questions:` metadata)

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

### Rating scale (likert)

List items are *statements*, all rated on one shared, ordered scale (1 to
`LIMITS.likertStatements` = 6 statements).

```markdown
## How did today go?

::: {.likert #feedback scale="agree-5"}
- The pace of today's lecture was right
- The examples helped
- I could follow the live coding
:::

## How confident are you running a t-test in R?

::: {.likert #confidence scale="0-10" low="Not at all" high="Completely"}
:::

::: {.likert #speed labels="Too slow|Just right|Too fast"}
- Pace of today's lecture
:::
```

| Scale | Points |
|---|---|
| `agree-5` (default) | Strongly disagree, Disagree, Neutral, Agree, Strongly agree |
| `agree-7` | Strongly disagree, Disagree, Somewhat disagree, Neutral, Somewhat agree, Agree, Strongly agree |
| `"<min>-<max>"`, e.g. `0-10`, `1-5` | Numeric: the integers from min to max, 2 to 11 points. `low=` / `high=` optionally name the ends. |
| `labels="a\|b\|c"` | Custom: 2 to 11 labels separated by `\|`, ordered low to high. Overrides `scale=`. |

A labeled scale (preset or custom) with an odd number of points has a
neutral middle point; an even one has none. Numeric scales are never split
at a neutral point; they are summarized by mean and median instead.

**Single statement.** Without a list, the question has one statement: the
prompt itself (attribute, div text or heading, as below). Neither the slide
nor the phones repeat a statement that is identical to the prompt, so the
heading-only form reads as one question with one row of buttons. A
one-item list keeps its item as a visible statement under the prompt.

### Question attributes

| Attribute | Applies to | Default | Meaning |
|---|---|---|---|
| `#id` | all | `q-` + first 10 hex digits of SHA-1 of prompt and options (and scale labels) | Question id on the server. Give one explicitly: editing the question changes a generated id, and its old results stay behind under the old id. |
| `prompt="..."` | all | see below | Overrides the prompt text sent to phones. |
| `results=` | all | config `results` | Per-question override. |
| `max-words=` | wordcloud | 3 | Words kept per answer. |
| `max-answers=` | wordcloud | 3 | Answers per person. |
| `scale=` | likert | `agree-5` | Preset or numeric range (table above). |
| `labels=` | likert | none | Custom scale labels, `\|`-separated, low to high. |
| `low=`, `high=` | likert, numeric scales | none | Words for the two ends, e.g. "Not at all" and "Completely". Ignored (with a warning) on labeled scales. |

The prompt sent to phones is, in order: the `prompt` attribute; else any
non-list text inside the div; else the text of the nearest preceding heading.

### Lua filter

- Runs only for revealjs output. For any other format the div is left as a
  plain list.
- Replaces each `.poll` / `.wordcloud` / `.likert` div with a container
  `div.lq-question.lq-poll` (or `.lq-wordcloud`, `.lq-likert`) carrying the
  same id and a `data-lq` JSON attribute: the `Question` definition plus
  `correct` (option indices, poll only, omitted if none) and `results`.
  Inside it keeps the original list, with task-list markers stripped, as the
  static fallback and as the source of the option (or statement) labels'
  HTML. A likert question also gets a `div.lq-scale-note` paragraph naming
  its scale, shown only in static mode and other formats.
- Resolves likert presets into explicit `labels` (and `numeric`, `anchors`),
  so the deck and server never need to know preset names.
- Writes the resolved config as JSON into
  `<script type="application/json" id="lq-config">` (in the document head).
- Warns (via `quarto.log.warning`) about duplicate ids, polls with fewer than
  two options, and values outside `LIMITS`. Out-of-range `max-words` /
  `max-answers` are clamped; over-long prompts, options, statements and
  scale labels are truncated. An unknown `scale=`, a range outside 2 to 11
  points, or fewer than 2 `labels=` falls back to `agree-5`. Task-list
  markers in a likert list are ignored with a warning.

As built, for example:

```html
<div id="capital" class="lq-question lq-poll"
     data-lq='{"type":"poll","id":"capital","prompt":"What is the capital of Australia?",
               "options":["Sydney","Canberra","Melbourne","Perth"],"correct":[1],"results":"live"}'>
  <div class="lq-text">…non-list content of the div, if any…</div>
  <ul><li>Sydney</li><li>Canberra</li>…</ul>
</div>
<div id="mood" class="lq-question lq-wordcloud"
     data-lq='{"type":"wordcloud","id":"mood","prompt":"One word for today’s lecture?",
               "maxWords":2,"maxAnswers":3,"results":"live"}'></div>
<div id="confidence" class="lq-question lq-likert"
     data-lq='{"type":"likert","id":"confidence","prompt":"How confident are you running a t-test in R?",
               "statements":["How confident are you running a t-test in R?"],
               "labels":["0","1","2","3","4","5","6","7","8","9","10"],"numeric":true,
               "anchors":["Not at all","Completely"],"results":"live"}'>
  <div class="lq-scale-note">…</div>
</div>

<script type="application/json" id="lq-config">
{"server":"http://localhost:8787","session":"example","closeOnLeave":true,"results":"live","qr":true}
</script>
```

- `correct` holds 0-based option indices. `server` is omitted when not
  configured (trailing slashes are stripped).
- The generated id is `q-` + the first 10 hex digits of
  `sha1(prompt .. "\n" .. options joined by "\n")`; for likert, the
  statements take the options' place and `"\n" .. labels joined by "|"` is
  appended.
- The default session is the input file stem with characters outside
  `[A-Za-z0-9_-]` replaced by `-` (runs collapsed, leading and trailing `-`
  dropped, cut to 64 characters).
- One extension contributes both the filter and the plugin; a document lists
  it under both `filters: [live-questions]` and `revealjs-plugins: [live-questions]`
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
- Likert questions follow the same lifecycle: phones rate while the question
  is open, results are withheld from phones until it closes, and leaving the
  slide closes it.

### Keys and controls

| Key | Action |
|---|---|
| `Q` | Toggle a full-screen QR overlay ("everyone scan this"). |
| `A` | Reveal the correct answer of the current poll (also closes voting). On a likert slide it only shows a "Rating scales have no answer to reveal" toast. |
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

- **Likert, labeled scale**: one diverging stacked bar per statement with the
  statement text above it and its response count to the right. The bar is
  centered on the neutral point: a neutral segment is split half each side
  of the center line, lower points stack to the left, higher points to the
  right. The share below and above the middle is printed outside each end
  (omitted on 2- and 3-point scales, where it would repeat the segment), each
  segment shows its percentage when it is wide enough, and a legend above
  lists the scale labels. All statements share one axis; its two sides are
  scaled independently (to the widest reach on each side, rounded up to 10%)
  so a lopsided result uses the whole width. The center line shows as ticks
  above and below each bar. Segments animate their position and width.
- **Likert, numeric scale**: one histogram per statement, a column per scale
  point (heights relative to the tallest column of the question), counts
  above the columns, a pointer under the baseline at the mean, and
  "mean x · median y" plus the response count in the statement's header.
  With 4 or more statements only the last histogram repeats the scale
  numbers. `low=`/`high=` anchors appear in the legend.
- **Likert palette**: a fixed red (low) / gray (neutral) / blue (high)
  diverging palette, five steps per arm, rather than the theme's link color
  (which may itself be red or orange). The plugin measures the luminance of
  `--r-background-color` and sets `data-lq-tone="dark"` on dark themes,
  which swap in steps chosen for a dark surface (brighter toward the ends).
  Text on every step has at least 4.5:1 contrast. The bar and text sizing
  shrinks (to 60% at most) like the bar chart; 1 to 6 statements fit a
  1050×700 slide with a heading and the QR panel.

The QR code comes from `qrcode-generator`, bundled into `live-questions.js`; there
are no CDN requests.

## Audience page

- `/s/<session>`, mobile first, light or dark from `prefers-color-scheme`, no
  external requests. `/` shows a "join a session" form.
- The voter id is a random UUID stored in `localStorage` (`lq:voter`), with an
  in-memory fallback.
- States: connecting; waiting for a question; poll open (large option buttons,
  current choice highlighted, the vote can be changed while open); word cloud
  open (text input, the voter's submitted answers as chips, answers remaining);
  likert open (below); closed (results as bars, a ranked word list, or one
  histogram per likert statement with the voter's own rating outlined and a
  "You: Agree" tag; correct options highlighted if revealed); offline
  (auto-reconnect with backoff).
- Likert open: one card per statement with the statement text, a row of
  segmented scale buttons (48 px tall) and the scale's end labels underneath
  (plus the neutral label, centered, on odd labeled scales). Labeled scales
  tint each button with the slide's palette color for that point and show
  the chosen label beside the statement; numeric scales show the numbers and
  "0 = Not at all … 10 = Completely" (or "lowest"/"highest" without
  anchors). Scales with 8 or more points wrap onto two rows below 460 px, so
  an 11-point scale fits a 360 px phone without horizontal scrolling. A
  rating can be changed while voting is open; a progress line reads "2 of 3
  rated" (or "Rating saved: Agree" for one statement). Ratings are sent
  optimistically and restored from `you` after a reload.
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

`/s/:session/` redirects to `/s/:session`. The HTML routes send a strict
Content-Security-Policy (same-origin scripts, styles and sockets only). The
export answers CORS preflights with `Access-Control-Allow-Origin: *` so a deck
page on another origin can fetch it; the key still gates it. Its body is
`{ session, live, questions }`, shaped like `DeckState` (presenter view, with
`hidden`) minus `audience`. WebSocket upgrades accept any `Origin`, since
decks are usually served from a different origin than the server.

### Connection handling (adapters)

- The first message must be `hello` with `v === PROTOCOL_VERSION`. The socket
  is a presenter only if `role === "deck"` and `key` matches `PRESENTER_KEY`
  (constant-time compare). If `PRESENTER_KEY` is unset, nobody is a presenter
  and the server logs a warning. A wrong `v` gets a `version` error and the
  server closes the socket with code 4000 (clients should not retry). Any
  other message before `hello` gets `not-hello`; a second `hello` is
  `bad-message`. `voter` must be 1 to 64 printable ASCII characters without
  spaces (a UUID is ideal).
- Right after `welcome`, a deck socket receives `deck`, and an audience socket
  receives `audience` then `you`, so a client never waits for a change to see
  the current state.
- Validation copies only known fields, so anything extra a deck sends in a
  question (for example `correct` or `results` from `data-lq`) is dropped and
  never stored or broadcast. Polls need 1 to `LIMITS.pollOptions` options;
  word clouds missing `maxWords`/`maxAnswers` get `DEFAULTS`. Likert
  questions need 1 to `LIMITS.likertStatements` statements and 2 to
  `LIMITS.likertPoints` labels; a numeric scale's labels must be consecutive
  integers, low to high; a missing `numeric` means false, and `anchors` is
  kept only on numeric scales (null otherwise).
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
  separately). A payload identical to the previous broadcast is not re-sent
  (votes on an open question change the deck state but not the audience
  state). `you` is sent right away, only to the voter's own sockets. After a
  `reset`, or an `open` that redefines a question with votes, every phone gets
  a fresh `you` in the next flush.
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
- A likert definition differs when its statements, labels, `numeric` or
  `anchors` differ; as for other types, `open` with a changed definition
  clears its ratings and every phone gets a fresh `you`.
- `reset {id}`: clear that question's votes, answers, reveal and hidden set;
  status is unchanged. `reset {}`: drop all questions and set `live = null`.
- `hide`: word clouds only. Normalizes `text` and adds it to or removes it
  from the hidden set.
- `reset` and a definition change clear likert ratings like votes and
  answers.
- `vote`: requires `id === live` and status `open`, and `choice` must be an
  integer in range. Last vote wins.
- `rate`: requires `id === live` and status `open`, a likert question, and
  `statement` and `choice` integers in range. The last rating per statement
  wins; re-sending the current rating is a no-op. Unrated statements are
  `null` in `Mine.ratings`.
- `answer`: requires `id === live` and status `open`. The text is normalized
  (below); an empty result is `bad-message`. Re-submitting an answer the voter
  already gave is a no-op. A new answer beyond `maxAnswers` is `limit`.
- A word cloud's word count is the number of distinct voters who submitted
  that normalized answer. `voters` counts distinct voters with at least one
  vote, answer or rating. Likert results are `counts[statement][point]`.
- `AudienceState.live.results` is `null` while the question is open, and so is
  `AudienceState.live.revealed` (re-opening a revealed question, e.g. when the
  deck reloads on that slide, must not show phones the answer mid-vote).
- Error codes: a question id the room doesn't know is `unknown-question`; a
  `vote`/`answer` for a known question that is not live and open is `closed`;
  `reveal` on anything but a poll, `hide` on anything but a word cloud, a
  vote, answer or rating for the wrong question type, and out-of-range
  indices are `bad-message`; presenter messages without presenter rights,
  and `vote`/`answer`/`rate` from a deck socket, are `forbidden`.
- Stored rooms from before likert existed load unchanged (`ratings` is
  optional in `RoomData`); `Mine.ratings` is new in protocol v1 and older
  clients ignore it.

### Answer normalization

1. Unicode NFKC, control characters removed, whitespace collapsed, trimmed.
2. Strip leading and trailing `. , ; : ! ? " ' ( ) [ ] { } …` and curly
   quotes. Symbols such as `+` and `#` are kept (`C++`, `C#`).
3. Keep the first `maxWords` whitespace-separated words, then cut to
   `LIMITS.answerChars` characters (code points), and strip step 2's
   characters again so a cut never leaves trailing punctuation. Invisible
   characters (U+200B, U+200C, U+2060, U+FEFF) are removed along with the
   control characters; U+200D is kept because emoji sequences use it.
4. The matching key is the lowercased result. The display text is the first
   spelling the room saw.

Truncation in step 3 is a server-side backstop. The audience page refuses an
answer with more than `maxWords` words and asks the voter to shorten it, so
"confusing at times" never lands in a two-word cloud as "confusing at". The
same `src/shared/normalize.ts` runs on both sides.

## Deployment

### Cloudflare

- `wrangler.jsonc`: Worker entry `src/server/cloudflare/worker.ts`, Durable
  Object class `SessionRoom` bound as `ROOMS` with a `new_sqlite_classes`
  migration (SQLite-backed Durable Objects are available on the free plan),
  static assets from `public/`, and a build step that bundles `public/vote.js`.
- Each session is `ROOMS.idFromName(session)`. The Worker forwards the
  WebSocket upgrade to the Durable Object, which accepts it with the
  hibernation API (`ctx.acceptWebSocket`) and keeps per-socket state (session,
  role, voter, presenter) in `serializeAttachment`. Sockets are not tagged:
  tags are fixed when the socket is accepted, but role and voter only arrive
  later in `hello`. Broadcasts filter `getWebSockets()` by attachment, which
  is cached in memory between hibernations.
- `assets.run_worker_first` routes `/`, `/s/*`, `/api/*` and `/healthz` to the
  Worker; `vote.js` and `vote.css` are served straight from the asset store.
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

- **Unit**: `bun test`. Covers the room rules, normalization, validation,
  the rate limiter, the connection hub and the word-cloud layout.
- **Smoke**: `bun scripts/smoke.ts <base-url> <key>` drives a presenter and
  several audience sockets through a poll (votes, vote change, close,
  rejected late vote, reveal), a word cloud (normalization, duplicates,
  limit, hide) and a likert question (ratings, rating change, out-of-range
  and wrong-type messages, reveal/hide rejected, rejected late rating), and
  checks that export requires the key and includes ratings. It runs against the
  Node server, `wrangler dev` and the Docker image.
- **Manual**: `bun scripts/presenter.ts <base> <key> <session> <command>`
  plays presenter (open polls, word clouds and likert questions; close,
  reveal, reset) and simulates phones (votes, answers, ratings) without a
  deck.
- **Deck**: render `example.qmd` and screenshot static mode with Playwright.
- **End to end**: a local server plus the rendered deck as presenter and the
  audience page in a phone viewport. Vote, then check that the slide's bars
  and word cloud update and that the QR code encodes the audience URL. The
  screenshots in `docs/screenshots/` were taken this way.
- **CI** (`.github/workflows/ci.yml`): type check and unit tests, the
  committed deck bundle matches a fresh build, the Node smoke test, a
  `wrangler deploy --dry-run` bundle of the Worker, a Quarto render of
  `example.qmd`, and a Docker build with the smoke test against the
  container.

## Security model and known limits

- Voter ids are generated by the client, so one person can vote again from a
  private window or with a script. That's acceptable for a classroom or talk
  audience; per-IP limits are possible later.
- Correct answers are embedded in the deck HTML (`data-lq`), so a determined
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
| Connection logic in a shared `Hub`, with each runtime implementing a small `HubHost` | The hello/auth, size limits, rate limiting, coalesced broadcasts and persistence timing are identical on both runtimes, so they live once in `src/server/hub.ts` and are unit-tested there. Each runtime only lists sockets, sends, stores per-socket info and persists. |
| Node WebSockets via `@hono/node-server` v2's built-in support (`ws`), not `@hono/node-ws` | `@hono/node-ws` only declares support for node-server v1. Using `ws` directly also enforces the message-size cap at the socket. |
| Per-socket state in `serializeAttachment`, not hibernation tags | Tags are fixed when the socket is accepted, but role and voter only arrive later in `hello`. |
| Session URL that follows the deck | The audience scans once per talk. A per-question QR code would make everyone rescan for every question. |
| Presenter key passed in the URL and kept in `localStorage`, never in the HTML | A published deck is safe to share, and only the presenter's browser controls questions. |
| Lua filter parses the markup | The plugin JS never reads markdown, and PDF and other non-HTML renders degrade to a plain list. |
| Task-list `[x]` marks correct answers | It's native Pandoc syntax that reads naturally in source. A plain list means a poll with no right answer. |
| Results hidden from phones while voting is open | Avoids bandwagon voting. The projected slide can also hide them (`results: hidden`). |
| Likert is its own question type, not a poll variant | A rating question has several statements on one shared scale (a poll has one), it needs a different chart (diverging bars centered on neutral, or histograms with a mean) and a different phone layout, and its scale comes from presets. A poll per statement would make the audience answer N separate questions with N slide changes, and the deck could not show the statements side by side. |
| Likert presets resolved in the Lua filter | The server and phones see only explicit labels and a `numeric` flag, so new presets need no server change and old servers keep working. |
| Likert phone layout: segmented buttons with end labels, not stacked full-label buttons | Stacked full-label lists are clearest for one statement, but six statements on a 7-point scale become 42 rows and several screens of scrolling. A segmented row keeps each statement to one card; the end (and neutral) labels anchor the direction, the button tints match the slide's colors, and the chosen label appears beside the statement so middle points like "Somewhat agree" are never ambiguous. Each button carries its full label for screen readers. |
| QR library bundled, no CDN | Decks work on venue Wi-Fi with captive portals or blocked CDNs, and the only network dependency is the server itself. |

## Out of scope for v1

CSV export, multi-select polls, likert scales with negative numeric ranges
in the markup (the protocol allows them), profanity filtering, per-IP rate limits,
automatic session expiry, multiple presenter keys or accounts, and a results
archive page.
