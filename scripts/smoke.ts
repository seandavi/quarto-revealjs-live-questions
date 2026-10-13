/**
 * Protocol smoke test against a running server (Node, `wrangler dev` or Docker).
 *
 *   bun scripts/smoke.ts http://localhost:8787 <PRESENTER_KEY> [session]
 *
 * Drives a presenter, a viewer and several audience sockets through a poll and
 * a word cloud, checks the error paths and the export route, and leaves the
 * session's data in place (its name is printed) so persistence can be checked
 * after a restart. Exits non-zero on the first failure.
 */
import type { ClientMessage, DeckState, ServerMessage, WordcloudResults } from "../src/shared/protocol";
import { PROTOCOL_VERSION, socketPath } from "../src/shared/protocol";

const [base = "http://localhost:8787", key = "dev", sessionArg] = process.argv.slice(2);
const session = sessionArg ?? `smoke-${Date.now().toString(36)}`;
const wsBase = base.replace(/^http/, "ws");
const TIMEOUT_MS = 5000;

let step = "";
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`${step}: ${what}`);
}

class Client {
  readonly ws: WebSocket;
  private queue: Array<ServerMessage | "raw-pong"> = [];
  private waiters: Array<() => void> = [];
  closed: { code: number } | null = null;

  constructor(readonly name: string) {
    this.ws = new WebSocket(wsBase + socketPath(session));
    this.ws.addEventListener("message", (e) => {
      const data = String(e.data);
      this.queue.push(data === '{"t":"pong"}' ? "raw-pong" : (JSON.parse(data) as ServerMessage));
      this.wake();
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = { code: e.code };
      this.wake();
    });
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  opened(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error(`${this.name}: socket error`)), { once: true });
    });
  }

  send(msg: ClientMessage | string) {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** Wait for (and consume) the first queued message matching `pred`. Earlier non-matching messages are discarded. */
  async next<T extends ServerMessage | "raw-pong">(
    pred: (m: ServerMessage | "raw-pong") => m is T,
    what: string,
  ): Promise<T>;
  async next(pred: (m: ServerMessage | "raw-pong") => boolean, what: string): Promise<ServerMessage | "raw-pong">;
  async next(pred: (m: ServerMessage | "raw-pong") => boolean, what: string) {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      while (this.queue.length) {
        const m = this.queue.shift()!;
        if (pred(m)) return m;
      }
      check(Date.now() < deadline && !this.closed, `${this.name}: timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  async deck(pred: (s: DeckState) => boolean, what: string): Promise<DeckState> {
    const m = await this.next((m) => m !== "raw-pong" && m.t === "deck" && pred(m.state), what);
    return (m as Extract<ServerMessage, { t: "deck" }>).state;
  }

  async audience(pred: (s: Extract<ServerMessage, { t: "audience" }>["state"]) => boolean, what: string) {
    const m = await this.next((m) => m !== "raw-pong" && m.t === "audience" && pred(m.state), what);
    return (m as Extract<ServerMessage, { t: "audience" }>).state;
  }

  async you(pred: (s: Extract<ServerMessage, { t: "you" }>["mine"]) => boolean, what: string) {
    const m = await this.next((m) => m !== "raw-pong" && m.t === "you" && pred(m.mine), what);
    return (m as Extract<ServerMessage, { t: "you" }>).mine;
  }

  error(code: string) {
    return this.next((m) => m !== "raw-pong" && m.t === "error" && m.code === code, `error '${code}'`);
  }

  close() {
    this.ws.close();
  }
}

async function connect(name: string, role: "deck" | "audience", voter: string, k?: string) {
  const c = new Client(name);
  await c.opened();
  c.send({ t: "hello", v: PROTOCOL_VERSION, role, voter, ...(k === undefined ? {} : { key: k }) });
  const w = await c.next((m) => m !== "raw-pong" && m.t === "welcome", "welcome");
  return { c, presenter: (w as Extract<ServerMessage, { t: "welcome" }>).presenter };
}

const words = (s: DeckState, id: string) => s.questions[id]?.results as WordcloudResults | undefined;

async function main() {
  const t0 = Date.now();
  console.log(`smoke: ${base} session=${session}`);

  step = "http";
  check((await (await fetch(`${base}/healthz`)).text()).trim() === "ok", "/healthz is not ok");
  check((await fetch(`${base}/`)).status === 200, "/ is not 200");
  const page = await fetch(`${base}/s/${session}`);
  check(page.status === 200 && (await page.text()).includes("vote.js"), "/s/<session> does not serve the vote page");
  check((await fetch(`${base}/s/bad%20name`)).status === 404, "invalid session name is not 404");
  check((await fetch(`${base}/vote.css`)).status === 200, "/vote.css is not served");
  check((await fetch(`${base}/vote.js`)).status === 200, "/vote.js is not served");

  step = "export auth";
  const exportUrl = `${base}/api/s/${session}/export`;
  check((await fetch(exportUrl)).status === 401, "export without a key is not 401");
  check((await fetch(exportUrl, { headers: { Authorization: "Bearer nope" } })).status === 401, "export with a wrong key is not 401");

  step = "hello";
  const { c: deck, presenter } = await connect("presenter", "deck", "deck-1", key);
  check(presenter, "presenter key was rejected (does the server have the same PRESENTER_KEY?)");
  await deck.deck((s) => s.session === session, "initial deck state");
  const { c: viewer, presenter: viewerIsPresenter } = await connect("viewer", "deck", "deck-2", "wrong-key");
  check(!viewerIsPresenter, "wrong key was accepted");
  const phones = await Promise.all(["a", "b", "c"].map((v) => connect(`phone-${v}`, "audience", `voter-${v}`)));
  const [a, b, c] = phones.map((p) => p.c) as [Client, Client, Client];
  for (const p of [a, b, c]) {
    await p.audience((s) => s.live === null, "initial audience state");
    await p.you((m) => Object.keys(m.votes).length === 0, "initial you");
  }
  await deck.deck((s) => s.audience === 3, "audience count 3");

  step = "errors";
  const early = new Client("early");
  await early.opened();
  early.send({ t: "vote", id: "q", choice: 0 });
  await early.error("not-hello");
  early.send("{nope");
  await early.error("bad-message");
  early.send({ t: "hello", v: PROTOCOL_VERSION + 1, role: "audience", voter: "x" });
  await early.error("version");
  viewer.send({ t: "open", question: { type: "poll", id: "x", prompt: "x", options: ["a", "b"] } });
  await viewer.error("forbidden");
  a.send({ t: "answer", id: "q", text: "x".repeat(4100) });
  await a.error("bad-message");

  step = "heartbeat";
  a.send('{"t":"ping"}');
  await a.next((m) => m === "raw-pong", "pong");

  step = "poll";
  deck.send({
    t: "open",
    // `correct` must be stripped by the server and never reach phones.
    question: { type: "poll", id: "lang", prompt: "Which language?", options: ["R", "Python", "Julia"], correct: [0] } as never,
  });
  for (const p of [a, b, c]) {
    const s = await p.audience((s) => s.live?.question.id === "lang", "poll is live");
    check(s.live?.status === "open" && s.live.results === null, "open poll should withhold results");
    check(!("correct" in (s.live?.question ?? {})), "correct answers leaked to phones");
  }
  a.send({ t: "vote", id: "lang", choice: 0 });
  b.send({ t: "vote", id: "lang", choice: 1 });
  c.send({ t: "vote", id: "lang", choice: 1 });
  await a.you((m) => m.votes.lang === 0, "a's vote");
  await deck.deck((s) => JSON.stringify(s.questions.lang?.results) === '{"type":"poll","counts":[1,2,0],"voters":3}', "counts 1,2,0");
  a.send({ t: "vote", id: "lang", choice: 2 });
  await a.you((m) => m.votes.lang === 2, "a's changed vote");
  await deck.deck((s) => JSON.stringify(s.questions.lang?.results) === '{"type":"poll","counts":[0,2,1],"voters":3}', "counts after change");
  await viewer.deck((s) => JSON.stringify(s.questions.lang?.results) === '{"type":"poll","counts":[0,2,1],"voters":3}', "viewer sees counts");

  step = "close";
  deck.send({ t: "close", id: "lang" });
  const closed = await b.audience((s) => s.live?.status === "closed", "poll closed");
  check(JSON.stringify(closed.live?.results) === '{"type":"poll","counts":[0,2,1],"voters":3}', "closed poll shows results");
  b.send({ t: "vote", id: "lang", choice: 0 });
  await b.error("closed");

  step = "reveal";
  deck.send({ t: "reveal", id: "lang", correct: [1] });
  await c.audience((s) => JSON.stringify(s.live?.revealed) === "[1]", "revealed [1]");

  step = "wordcloud";
  deck.send({ t: "open", question: { type: "wordcloud", id: "mood", prompt: "One word?", maxWords: 2, maxAnswers: 3 } });
  await deck.deck((s) => s.live === "mood" && s.questions.lang?.status === "closed", "cloud live, poll closed");
  for (const p of [a, b, c]) await p.audience((s) => s.live?.question.id === "mood" && s.live.status === "open", "cloud is live");
  a.send({ t: "answer", id: "mood", text: "  Big Data!!  " });
  await a.you((m) => JSON.stringify(m.answers.mood) === '["Big Data"]', "a's normalized answer");
  b.send({ t: "answer", id: "mood", text: "big data." });
  await b.you((m) => JSON.stringify(m.answers.mood) === '["big data"]', "b's answer");
  b.send({ t: "answer", id: "mood", text: "BIG DATA" }); // duplicate: no-op
  b.send({ t: "answer", id: "mood", text: "statistics is fun" }); // cut to 2 words
  await b.you((m) => JSON.stringify(m.answers.mood) === '["big data","statistics is"]', "b's second answer, duplicate ignored");
  for (const w of ["one", "two", "three"]) c.send({ t: "answer", id: "mood", text: w });
  await c.you((m) => m.answers.mood?.length === 3, "c's three answers");
  c.send({ t: "answer", id: "mood", text: "four" });
  await c.error("limit");
  const cloud = await deck.deck((s) => words(s, "mood")?.voters === 3 && words(s, "mood")?.words.length === 5, "5 cloud words");
  const top = words(cloud, "mood")!.words[0];
  check(top?.text === "Big Data" && top.count === 2, `top word should be Big Data x2, got ${JSON.stringify(top)}`);

  step = "hide";
  deck.send({ t: "hide", id: "mood", text: "big data", hidden: true });
  const hidden = await deck.deck((s) => words(s, "mood")?.hidden?.length === 1, "hidden list");
  check(JSON.stringify(words(hidden, "mood")?.hidden) === '["Big Data"]', "hidden display form");
  check(!words(hidden, "mood")!.words.some((w) => w.text === "Big Data"), "hidden word still broadcast");
  const v = await viewer.deck((s) => words(s, "mood")?.words.length === 4, "viewer sees 4 words");
  check(words(v, "mood")?.hidden === undefined, "viewer must not see the hidden list");
  deck.send({ t: "close", id: "mood" });
  const phoneCloud = await a.audience((s) => s.live?.status === "closed", "cloud closed");
  const pw = phoneCloud.live?.results as WordcloudResults;
  check(pw.words.length === 4 && pw.hidden === undefined, "phones get results without hidden words");

  step = "export";
  const exp = await fetch(exportUrl, { headers: { Authorization: `Bearer ${key}` } });
  check(exp.status === 200, `export with key returned ${exp.status}`);
  const body = (await exp.json()) as { session: string; questions: DeckState["questions"] };
  check(body.session === session && body.questions.lang && body.questions.mood, "export is missing questions");
  check(JSON.stringify(words(body as DeckState, "mood")?.hidden) === '["Big Data"]', "export is missing hidden words");

  for (const cl of [deck, viewer, a, b, c, early]) cl.close();
  console.log(`smoke: OK in ${Date.now() - t0} ms (session ${session} left in place)`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`smoke: FAILED ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
