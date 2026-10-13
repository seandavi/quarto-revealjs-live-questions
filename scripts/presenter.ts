/**
 * Play presenter from the command line: send one presenter message, and
 * optionally simulate audience votes, without a deck. Handy for trying the
 * audience page and for taking screenshots.
 *
 *   bun scripts/presenter.ts <base> <key> <session> <command> [args]
 *
 * Commands:
 *   poll <id> <prompt> <option>...    open a poll
 *   cloud <id> <prompt> [maxWords] [maxAnswers]   open a word cloud
 *   likert <id> <prompt> <scale> <statement>...    open a likert question;
 *                                     <scale> is agree-5, agree-7, a range
 *                                     like 0-10, or labels like "No|Maybe|Yes"
 *   close <id> | reveal <id> <index>... | reset [id]
 *   votes <id> <count>...             simulate phones: <count> votes per option
 *   answers <id> <text>...            simulate one phone per answer
 *   ratings <id> <counts>...          simulate phones rating a likert question:
 *                                     one comma-separated list of counts per
 *                                     scale point for each statement, e.g.
 *                                     "1,2,5,3,1" "0,1,2,6,3"
 */
import type { ClientMessage, LikertQuestion } from "../src/shared/protocol";
import { PROTOCOL_VERSION, socketPath } from "../src/shared/protocol";

const [base, key, session, command, ...args] = process.argv.slice(2);
if (!base || !key || !session || !command) {
  console.error("usage: bun scripts/presenter.ts <base> <key> <session> <command> [args]");
  process.exit(2);
}
const url = base.replace(/^http/, "ws") + socketPath(session);

function open(role: "deck" | "audience", voter: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, role, voter, key: role === "deck" ? key : undefined }));
    });
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t === "welcome") {
        if (role === "deck" && !m.presenter) reject(new Error("presenter key rejected"));
        else resolve(ws);
      } else if (m.t === "error") console.error(`${role} ${voter}: ${m.code} ${m.message}`);
    });
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 400));

// The Lua filter's presets, repeated here so the CLI accepts the same names.
const AGREE_5 = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];
const AGREE_7 = ["Strongly disagree", "Disagree", "Somewhat disagree", "Neutral", "Somewhat agree", "Agree", "Strongly agree"];

function scale(spec: string): Pick<LikertQuestion, "labels" | "numeric" | "anchors"> {
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) {
    const lo = Number(range[1]);
    const labels = Array.from({ length: Number(range[2]) - lo + 1 }, (_, i) => String(lo + i));
    return { labels, numeric: true, anchors: null };
  }
  const labels = spec === "agree-5" ? AGREE_5 : spec === "agree-7" ? AGREE_7 : spec.split("|");
  return { labels, numeric: false, anchors: null };
}

/** `ratings` arguments → one list of (statement, choice) pairs per simulated phone. */
function phoneRatings(lists: string[]): Array<Array<[number, number]>> {
  const phones: Array<Array<[number, number]>> = [];
  lists.forEach((list, statement) => {
    const choices = list.split(",").flatMap((c, choice) => Array<number>(Number(c)).fill(choice));
    choices.forEach((choice, k) => (phones[k] ??= []).push([statement, choice]));
  });
  return phones;
}

async function main() {
  const [id = "", ...rest] = args;
  if (command === "ratings") {
    const sockets: WebSocket[] = [];
    let n = 0;
    for (const ratings of phoneRatings(rest)) {
      const ws = await open("audience", `sim-ratings-${n++}`);
      for (const [statement, choice] of ratings) ws.send(JSON.stringify({ t: "rate", id, statement, choice } satisfies ClientMessage));
      sockets.push(ws);
    }
    await settle();
    for (const ws of sockets) ws.close();
    return;
  }
  if (command === "votes" || command === "answers") {
    const sockets: WebSocket[] = [];
    let n = 0;
    const items = command === "votes" ? rest.flatMap((c, i) => Array<number>(Number(c)).fill(i)) : rest;
    for (const item of items) {
      const ws = await open("audience", `sim-${command}-${n++}`);
      const msg: ClientMessage =
        typeof item === "number" ? { t: "vote", id, choice: item } : { t: "answer", id, text: item };
      ws.send(JSON.stringify(msg));
      sockets.push(ws);
    }
    await settle();
    for (const ws of sockets) ws.close();
    return;
  }
  let msg: ClientMessage;
  switch (command) {
    case "poll":
      msg = { t: "open", question: { type: "poll", id, prompt: rest[0] ?? "", options: rest.slice(1) } };
      break;
    case "cloud":
      msg = {
        t: "open",
        question: { type: "wordcloud", id, prompt: rest[0] ?? "", maxWords: Number(rest[1] ?? 3), maxAnswers: Number(rest[2] ?? 3) },
      };
      break;
    case "likert":
      msg = { t: "open", question: { type: "likert", id, prompt: rest[0] ?? "", statements: rest.slice(2), ...scale(rest[1] ?? "agree-5") } };
      break;
    case "close":
      msg = { t: "close", id };
      break;
    case "reveal":
      msg = { t: "reveal", id, correct: rest.map(Number) };
      break;
    case "reset":
      msg = id ? { t: "reset", id } : { t: "reset" };
      break;
    default:
      throw new Error(`unknown command ${command}`);
  }
  const ws = await open("deck", "cli-presenter");
  ws.send(JSON.stringify(msg));
  await settle();
  ws.close();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(String(err));
    process.exit(1);
  },
);
