# AI Interview Agent

A personalised, multi-turn AI technical interviewer for a 31-day AI engineering
cohort. It reads a candidate's real learning-journey data — which missions they
passed, failed, skipped, and how many attempts each took — builds an interview
plan around their actual weak spots, asks follow-up questions derived from what
they just said, and produces structured feedback at the end.

Built for the ABTalks Vibe Code Hackathon, Problem Statement 2.

- **Live demo:** _add your Render URL here_
- **Repo:** _add your GitHub URL here_

---

## What it actually does

Given `CAND-001` (Sarah Johnson, Senior Data Engineer, 9 years — passed most
missions first try, took 4 attempts on prompt engineering, 3 on Docker, and
skipped observability entirely), the server picks these five curriculum days:

| # | Day | Topic | Why it was chosen |
|---|-----|-------|-------------------|
| 1 | 7 | Embeddings Explained | passed first try — baseline / rapport check |
| 2 | 8 | Vector Databases Overview | passed first try — baseline / rapport check |
| 3 | 12 | Prompt Engineering Fundamentals | passed after 4 attempts — moderate struggle |
| 4 | 28 | Docker & Kubernetes Deployment | passed after 3 attempts — moderate struggle |
| 5 | 29 | Monitoring, Logging & Observability | skipped the mission — probe for baseline understanding |

Each topic gets two turns: an opening question calibrated to the candidate's role
and experience, then a follow-up generated from their actual answer. Ten
questions across five distinct days, then a JSON assessment.

The plan opens on the lowest-pressure topic and ramps toward the hardest, the way
a real interviewer warms someone up before pushing.

---

## Setup

Requires Node 20+.

```bash
npm install
```

```bash
cp .env.example .env
```

Put your Anthropic API key in `.env` (get one from the
[Anthropic Console](https://console.anthropic.com/settings/keys)):

```
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm start
```

Then open <http://localhost:3000>. The server refuses to boot without a key —
failing at startup is better than failing halfway through a judge's interview.

To run the end-to-end contract test against a running server:

```bash
npm test
```

---

## The API

One endpoint, no authentication: `POST /api/interview`.

### Start a session

```bash
curl -s -X POST http://localhost:3000/api/interview \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "abc-123",
    "candidate": {
      "member": { "id": "CAND-001", "name": "Sarah Johnson", "jobRole": "Senior Data Engineer", "yearsExperience": 9 },
      "missions": [
        { "day": 7,  "title": "Embeddings Explained",  "passed": true, "attempts": 1 },
        { "day": 12, "title": "Prompt Engineering",    "passed": true, "attempts": 4 },
        { "day": 28, "title": "Docker & Kubernetes",   "passed": true, "attempts": 3 },
        { "day": 29, "title": "Monitoring & Logging",  "skipped": true }
      ],
      "signals": { "commitDays": 28, "missionsCompleted": 30, "missionsFirstTry": 20 }
    }
  }'
```

```json
{ "reply": "Thanks for making the time, Sarah...\n\nYou mentioned...", "done": false }
```

### Answer a question

Every subsequent call carries `message` and no `candidate`:

```bash
curl -s -X POST http://localhost:3000/api/interview \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "abc-123",
    "message": "I chunk documents at around 500 tokens with a 50-token overlap, embed them with a sentence-transformer, and retrieve the top 5 by cosine similarity."
  }'
```

```json
{ "reply": "You picked 500 tokens with 50-token overlap — what did you compare that against?", "done": false }
```

Repeat. The follow-up above is not a template: it is built from the specific
numbers in the previous answer.

### The final turn

The server decides when the interview is over — after the tenth question is
answered. That response carries the feedback:

```json
{
  "reply": "Interview completed.",
  "done": true,
  "feedback": {
    "summary": "Sarah reasons fluently about retrieval mechanics but defaults to cohort-provided parameters without validating them...",
    "strengths": ["Explained the embed-then-retrieve pipeline precisely, including overlap and top-k choices", "..."],
    "gaps": ["Chose a 500-token chunk size because the course used it, and had not benchmarked alternatives", "..."],
    "next": ["Run a chunk-size sweep against a labelled question-passage set and record recall@k", "..."]
  }
}
```

`summary` is a string; `strengths`, `gaps` and `next` are `string[]`.

### Walking a whole interview from the shell

Start a session using a bundled candidate, then answer twelve times and watch it
terminate on its own:

```bash
SID="demo-$(date +%s)" && CAND=$(curl -s localhost:3000/api/candidates/CAND-001 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(d).candidate)))') && curl -s -X POST localhost:3000/api/interview -H 'content-type: application/json' -d "{\"sessionId\":\"$SID\",\"candidate\":$CAND}" && for i in $(seq 1 12); do curl -s -X POST localhost:3000/api/interview -H 'content-type: application/json' -d "{\"sessionId\":\"$SID\",\"message\":\"I used a managed vector index and took the top five chunks by cosine similarity, but I never benchmarked the chunk size against anything.\"}"; echo; done
```

`npm test` does the same walk with 45 assertions, and is the better option.

### Errors

Bad input gets a clean 4xx with a readable `error` string, never a 500:

| Situation | Status |
|---|---|
| missing/blank `sessionId`, empty `message`, malformed candidate, non-JSON body | `400` |
| `message` for a `sessionId` that was never started (or has expired) | `404` |
| `candidate` for a `sessionId` that already exists | `409` |
| a `message` sent after the interview finished | `200` — replays the final payload |

That last one is deliberate. A client that retries its last turn, or a harness
that sends one message too many, gets the same valid `done: true` body back
rather than an error.

### Demo-only endpoints

Not part of the graded contract; they exist so the bundled UI has something to
talk to.

| Endpoint | Purpose |
|---|---|
| `GET /api/candidates` | `[{ id, name, jobRole }]` for the picker |
| `GET /api/candidates/:id` | the full candidate object, ready to POST |
| `GET /api/interview/:sessionId/meta` | plan, current index, and per-topic live verdicts, for the progress rail |
| `GET /health` | status, model, active session count, uptime |

`/api/interview/:sessionId/meta` exists specifically so the UI can show real
personalisation data — the actual curriculum days chosen and why — **without**
adding fields to the graded `POST /api/interview` response, whose shape is
pinned exactly by the spec.

---

## Architecture

### Why Express + Render, not serverless

The interview is a state machine spread across a dozen HTTP requests. Turn 7
needs to know which topic it is on, what was asked in turn 6, and what the
candidate has already said. Serverless functions are stateless between
invocations: two turns can land on different instances, and any in-memory
session either disappears or is silently absent. You would have to bolt on
Redis or a database to hold what is fundamentally short-lived conversation
state.

A single long-running Node process holds `Map<sessionId, sessionState>`
directly. Sessions idle for more than 30 minutes are swept so memory stays
bounded across a multi-day judging window. Render's free web service is a
persistent process, so this works there; Vercel and Netlify functions would not.

### Why a deterministic plan wrapping the LLM

The requirement is at least 8 questions across at least 4 distinct curriculum
days. The tempting approach is to describe that to the model and let it manage
the interview. That makes a hard compliance requirement depend on the model
counting correctly across a dozen independent calls, and there is no way to
guarantee it.

So the split is: **the server owns structure, the model owns language.**

`src/engine/plan.js` scores the candidate's missions (skipped 100, failed 90,
5+ attempts 70, 3+ attempts 50, 2 attempts 30, clean pass 10), picks three
struggle topics, reserves two slots for baseline/rapport checks, and pads from
unseen curriculum days if the candidate's record is sparse. Five topics, two
turns each. Topic advancement and end-of-interview timing are plain integer
arithmetic in the route handler.

That makes coverage a property of the code. It holds even when every single
Claude call fails — verified, see below.

What the model does own is the part it is good at: writing a question pitched at
a Business Analyst with 8 years' experience versus a Junior Developer with none,
and turning "I picked 500 tokens because the course used it" into a follow-up
about benchmarking.

### Live answer grading

The follow-up call does two jobs in one request: it grades the answer
(`strong` / `partial` / `weak`) and writes the next thing the interviewer says.
A `weak` verdict makes the interviewer correct the misconception in its own
voice — "ah, careful, that's not quite how X behaves" — before asking an easier
question on the same topic, rather than politely moving on.

Two constraints shape how this is wired:

- **The verdict never appears in the API response.** `POST /api/interview`
  returns exactly `{ reply, done }`, unchanged. The verdict is session state,
  exposed only through the demo `/meta` endpoint; the UI reads it by diffing
  that between turns.
- **Grading changes what is said, not the structure.** Still five topics, two
  question-turns each, regardless of how well anyone answers — so the
  8-question / 4-day floor stays a property of the code.

Verdicts are passed into the final feedback prompt so `strengths` and `gaps`
cannot contradict what was flagged mid-interview. In the UI, a completed rail
tile swaps its pre-interview caption ("4 attempts") for the live result
("Needed a correction"), and the graded answer bubble picks up a small badge.

### Reliability around the LLM

Every Claude call is wrapped with:

- **a real timeout** (15s for questions, 25s for feedback) enforced by the SDK,
  which aborts the request. A `Promise.race` would reject the promise and leave
  the socket open.
- **retry with exponential backoff and jitter**, 2 retries — but only for
  transient failures. A 401 or 400 fails immediately rather than burning three
  attempts on a request that cannot succeed. `maxRetries: 0` is set on the SDK
  client so its internal retry does not multiply with ours.
- **a fallback that keeps the interview running.** A failed question call falls
  back to a per-topic-type template; a failed feedback call falls back to an
  assessment assembled from what the server knows without the model (topics
  covered, question count, the candidate's own mission record) — explicitly
  labelled as such rather than fabricating insight it does not have.
- **structured logging** of latency, token counts and estimated cost:
  ```
  [claude] tag=question attempt=1/3 status=ok latency_ms=2118 in_tok=487 out_tok=71 est_cost_usd=0.00168 stop=end_turn chars=284
  ```

Thinking configuration is set explicitly on every call rather than left to
default. On Sonnet 5 adaptive thinking is **on** when `thinking` is omitted, and
`max_tokens` caps thinking plus response text together — so a 1024-token budget
for a "2–4 sentence question" could be eaten by thinking and truncated. Question
calls run thinking-off at low effort; the feedback call, the one real judgement
task, gets adaptive thinking at medium effort.

The feedback call also uses **schema-constrained output**, so the API itself
guarantees the JSON shape. The defensive parser is still there behind it
(strips code fences, tolerates surrounding prose, validates every field, coerces
array items) because this is the one response the graded contract depends on. If
schema-constrained output is rejected, it retries once on prompting alone.

### Prompt sizing

No call sends the full curriculum or the full candidate object. A question call
sees one curriculum day plus a one-line calibration note about that day, and the
rolling context is capped at the last four turns. The feedback call gets a
condensed topic/Q/A digest, not the raw history. Cost per turn stays flat as the
interview grows instead of climbing.

---

## Verifying the fallbacks

The contract must hold when Claude is unreachable. Point the SDK at a dead port
and run the test suite:

```bash
ANTHROPIC_API_KEY=sk-ant-anything ANTHROPIC_BASE_URL=http://127.0.0.1:9 PORT=3001 node server.js
```

```bash
BASE_URL=http://localhost:3001 npm test
```

All 45 assertions pass with every Claude call failing: 10 questions across 5
distinct days, valid feedback JSON, correct status codes. The logs show 12 calls
× 3 attempts → 12 fallbacks.

To check the non-transient path instead, use a syntactically valid but wrong API
key — the logs should show one attempt, `transient=false`, and no retries.

---

## Frontend

Plain HTML/CSS/JS served as static files by the same Express process. No build
step, no framework.

The visual language is **Dark Bold (Enterprise)**: a flat `#0A0A0B` ground, solid
high-contrast panels, and one bold warm-orange accent doing all the signalling.
No blur, no glass, no gradient mesh, no ambient animation.

Panels are solid `#151517` (`#16161A` when elevated) with a
`1px solid rgba(255,255,255,0.08)` border, a 14px radius and a single
`0 4px 20px rgba(0,0,0,0.4)` drop shadow. There is no `backdrop-filter` anywhere
in the stylesheet.

Colour is used as signal, not decoration: orange `#FF7A1A` for active state,
primary actions and progress fill; green `#3DD68C` for completed steps and
strengths; coral `#F2836B` for gaps; amber `#F0B860` for next steps. Type is
Space Grotesk at 700 for headings and stat numbers, Inter for body and
transcript, IBM Plex Mono for day tags and counters.

The signature element is the **progress rail**: one solid rounded-square day
tile per planned topic, each captioned with *why* that day was chosen —
`Skipped`, `4 attempts`, `Passed 1st try — baseline`, `No record — general
probe`. Upcoming tiles are a muted dark fill, the current one is orange,
completed ones are green with a checkmark, and the connector between them fills
as progress is made. The captions are derived client-side from the same
`missionData` that drove selection server-side, so a plan that jumps
7 → 8 → 12 → 28 → 29 reads as deliberate rather than random. Fed from
`/api/interview/:sessionId/meta`.

The picker screen carries one hero visual: a `<canvas>` node network in
`public/hero.js` (vanilla canvas 2D, no library). Each node has a simulated
depth `z`; on pointer move every node shifts by an amount proportional to its
own `z`, so near nodes travel further than far ones. That parallax across depth
layers is what produces the 3D read — the per-node sphere shading and the
sub-pixel blur on distant nodes only reinforce it. Nodes drift on independent
sine paths and connect to nearby neighbours with opacity scaled by distance and
depth, evoking the curriculum as a connected network. It is bounded to a region
beside the headline (never full-viewport), paints one synchronous frame before
handing over to `requestAnimationFrame`, pauses via `IntersectionObserver` when
scrolled out of view, drops node count on narrow viewports, and freezes entirely
under `prefers-reduced-motion`. It loads as a separate script from `app.js` so a
failure in decoration cannot take down the candidate fetch.

The interview screen opens with an initials avatar, a `Let's begin, {name} 👋`
greeting and the candidate's role and experience as a muted subtitle. The
feedback screen opens with a row of stat cards — questions asked, days covered,
strengths count, gaps count — then the summary in bold display type, then three
solid cards with green / coral / amber top accent bars.

Because the panels are opaque, contrast is a fixed known quantity rather than
something that shifts with whatever gradient sits behind a panel. Measured on the
actual fills, every text/background pair clears WCAG AA: 16.6:1 for primary text
on panel, 9.9:1 for body copy, 5.9:1 for the dimmest small text, 7.0:1 for orange
on panel, and 7.3:1 for the dark text used on orange fills. Focus rings are a
2px orange outline with offset on every interactive element, and candidate cards
additionally reveal their accent bar on keyboard focus.

Only the message fade-in, the report fade-in and the thinking-pill dots are
animated, so that is all `prefers-reduced-motion: reduce` needs to gate.

Verified on a 375×812 profile: no horizontal overflow on any screen, the rail
switches to a horizontally-scrolling row with captions intact, and zero
`backdrop-filter` layers.

---

## Deploying to Render

1. Push this repo to GitHub (public).
2. In Render: **New → Web Service**, connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. **Environment → Add Environment Variable:**
   `ANTHROPIC_API_KEY` = your key. Do not set `PORT`; Render injects it.
5. Deploy, then confirm `https://<your-service>.onrender.com/health` returns
   `{"status":"ok",...}`.

Two things to know about the free tier:

- It sleeps after ~15 minutes idle, and the next request pays a cold start of
  roughly 30–50 seconds. Hit `/health` before demoing.
- A restart clears all in-memory sessions. An interview in progress ends; a new
  one starts fine. Given sessions are 30-minute-TTL conversation state, that is
  the right trade for this scope — persisting them would mean adding a database
  to store data that is intentionally disposable.

---

## Project layout

```
server.js                  Express app: helmet + CSP, CORS, static, /health, fail-fast boot
src/
  engine/
    sessionStore.js        Map<sessionId, state> + TTL sweep + overwrite/missing guards
    plan.js                deterministic topic scoring and selection
    claude.js              SDK wrapper: timeout, retry, fallbacks, prompts, logging
  routes/
    interview.js           POST /api/interview — validation + state machine
    candidates.js          demo-only picker data (rate-limited)
    meta.js                demo-only plan/progress for the rail
  data/                    curriculum.json + candidates.json
public/
  index.html  styles.css  app.js
scripts/
  test-interview.js        45-assertion end-to-end contract test
curriculum.json            provided (also in src/data/)
candidates.json            provided (also in src/data/)
technical-spec.md          provided
PROMPTS.md                 build log
```

`curriculum.json` and `candidates.json` are bundled at the repo root as provided
and mirrored under `src/data/` where the code loads them from.
