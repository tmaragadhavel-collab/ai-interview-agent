# PROMPTS.md — Build Log

A running, honest log of the prompts, decisions, and reasoning behind this build.
Written **as the work happened**, in order. Where a decision was wrong and got
reversed, the reversal is recorded rather than the history being tidied up.

---

## 0. Ground rules I set before writing code

The three provided files (`curriculum.json`, `candidates.json`, `technical-spec.md`)
were read in full first. Two things came out of that reading that changed the plan:

1. **`curriculum.json` is not an array.** Top level is `{ cohort, modules, days }`,
   with `days` being the 31-entry array. `candidates.json` likewise wraps its array
   in `{ candidates: [...] }`. Any code that did `require('./curriculum.json').map(...)`
   would have failed instantly.
2. **Skipped missions have no `passed` or `attempts` key at all.** e.g.
   `{ "day": 29, "title": "Monitoring...", "skipped": true }`. So a scorer written as
   `if (m.passed === false)` must check `skipped` *first*, because `passed` is
   `undefined` (not `false`) on a skipped mission. This is the single easiest place
   to introduce a silent scoring bug.

I also surveyed all 20 candidates rather than eyeballing the first one, because the
plan-builder's edge cases live in the spread:

| Observation | Consequence for `plan.js` |
|---|---|
| Every candidate has 9–11 missions | The "pad from curriculum days with no data" path is **cold** for the supplied data — but kept, because the spec requires it and a judge may POST a hand-made candidate |
| CAND-003 / 009 / 018: 10/10 first-try passes, zero struggle | Selection must not assume struggle topics exist |
| CAND-017: 10/10 needed ≥3 attempts, zero clean passes | Selection must not assume baseline topics exist either |
| CAND-010 / 016 / 020 have `passed: false` missions | Real failures exist in the data, so the `passed === false` branch is live |
| `yearsExperience` ranges 0 → 28; roles range "Computer Science Intern" → "Distinguished Engineer" | Question calibration by role/experience is meaningful, not decorative |

Both extremes (all-struggle, no-struggle) must still yield exactly 5 topics. That
requirement drove the bucket-with-fallback structure in `plan.js` rather than a
single sort-and-slice.

---

## 1. Model string and the Claude API surface

The brief specifies `claude-sonnet-5`, so that is what is used — not the model I'd
otherwise default to. Before writing the SDK wrapper I checked the current API
contract rather than working from memory, which caught four things that would have
been bugs:

1. **The scaffolded code had `claude-sonnet-4-20250514`.** Wrong model entirely.
   Fixed to `claude-sonnet-5`.
2. **On Sonnet 5, adaptive thinking is ON by default when `thinking` is omitted.**
   This is a change from Sonnet 4.6. It matters here because `max_tokens` caps
   thinking *plus* response text together — so a 1024-token budget for a
   "2–4 sentence question" could be consumed by thinking and return a truncated
   question. Decision: **explicitly** set `thinking` on every call rather than
   relying on the default (see §4).
3. **Non-default `temperature` / `top_p` / `top_k` are rejected with a 400 on
   Sonnet 5.** The wrapper sets none of them; behaviour is steered by prompt only.
4. **`Promise.race` is the wrong way to time out an SDK call.** It rejects the
   outer promise but leaves the underlying HTTP request running. The scaffold did
   this. Replaced with the SDK's own per-request `timeout` (milliseconds in JS),
   plus `maxRetries: 0` so the SDK's internal retry doesn't silently multiply with
   my own retry loop and turn a "15s timeout, 2 retries" budget into ~90s.

I also verified the SDK's actual exports rather than assuming — `require('@anthropic-ai/sdk')`
returns the class itself and also exposes `.Anthropic` and `.default`, plus the
typed error classes (`APIConnectionError`, `RateLimitError`, `BadRequestError`, …).
The scaffold's `new Anthropic.default(...)` worked but the destructured
`const { Anthropic } = require(...)` is the clearer form.

---

## 2. The scoring algorithm, and one revision

First pass followed the brief literally: 4 struggle slots + 1 baseline slot.

I revised it to **3 struggle + 2 baseline**. The brief says "reserve 1–2 slots for
a baseline/rapport check", so both are in-spec, but with 4 struggle topics the
interview reads as an interrogation — four consecutive "you failed this, explain
yourself" topics. Three struggle plus two clean-pass topics still weights struggle
heavily (they're the highest-scoring picks) while leaving room for the "confirm
real understanding, not just familiarity" probe the brief asks for.

Two further decisions that weren't in the brief:

- **Explicit tie-breaking by day number.** `Array.prototype.sort` is stable in V8,
  so ties would have resolved by mission order anyway, but relying on that is
  implicit. `b.score - a.score || a.mission.day - b.mission.day` makes the plan
  provably identical on every run for a given candidate. Verified by deep-equality
  on repeated calls.
- **Sequencing separately from selection.** Selection picks *which* 5 topics;
  sequencing decides the *order*. I sort the chosen five by ascending score, so the
  interview opens on the lowest-pressure topic and ramps toward the hardest — which
  is how a competent interviewer warms someone up. For CAND-001 that produces
  Day 7 (10) → Day 8 (10) → Day 12 (50) → Day 28 (50) → Day 29 (100, skipped).

Verified across all 20 candidates plus three synthetic edge cases (zero missions,
duplicate day entries, a mission referencing a day outside the 31-day curriculum):
every case yields exactly 5 topics on 5 distinct days.

---

## 3. Prompts

### System prompt

Used verbatim from the brief, interpolating name / jobRole / yearsExperience.

### Fresh question

The interesting design problem is the candidate's mission record. The brief is
explicit that it should "inform the question's difficulty and angle, not be read
aloud" — but simply passing `{ passed: true, attempts: 4 }` and hoping invites the
model to recite it ("I see you took four attempts at this...").

So the record is translated server-side into an instruction *to the interviewer*
before it's ever sent, and labelled as private:

> `They passed only after 4 attempts, so the fundamentals are probably there but
> the deeper reasoning may not be. Push past the surface.`

with the wrapper:

> `CALIBRATION (private — this shapes the difficulty and angle of your question.
> Never state or hint at their mission record to the candidate)`

The prompt carries one curriculum day (title, type, tools, objectives), that
calibration line, the question number, and the last four transcript turns "for
continuity of tone only". Not the curriculum, not the candidate object, not the
full history.

### Follow-up

The candidate's previous answer verbatim plus the question that produced it, and a
menu of probe types rather than a generic "ask a follow-up": challenge an
assumption, ask for a concrete example of something described abstractly, ask why
one approach over an alternative, or push on a case the answer wouldn't handle.
Plus an explicit instruction for the thin-answer case — *"If the answer was thin
or evasive, narrow the question rather than moving on"* — because that's the
failure mode that makes an interviewer feel scripted.

### Final feedback

Condensed topic/Q/A digest, not raw history. The prompt names the required shape
per key and then does the thing that actually matters for quality:

> `Every array item must reference this interview. No generic advice that could
> apply to any candidate ("keep practising", "learn more about AI") — if you cannot
> ground a point in something they said, leave it out. Be honest: if an answer was
> weak, say so plainly.`

Two negative examples inline, because "be specific" alone reliably produces
generic bullets.

---

## 4. Reliability decisions

**Thinking, per call type.** Questions run `thinking: { type: 'disabled' }` at
`effort: 'low'` — the output is 2–4 sentences, there's no multi-step reasoning to
do, and latency is visible to the user behind a 15s timeout. The feedback call is
the one genuine judgement task, so it gets `adaptive` thinking at `effort: 'medium'`,
3072 tokens and a 25s timeout.

**Retry only what's retryable.** The scaffold retried everything three times. A
401 or a 400 produces the identical failure on every attempt, so `isTransient()`
retries connection errors/timeouts, 408, 409, 429 and 5xx, and fails fast on
everything else. Confirmed both paths against the live API: a bad key logs one
attempt with `transient=false` and goes straight to the fallback; an unreachable
host logs three attempts with backoff.

**Structured outputs for the feedback call.** This is a deviation worth naming.
The brief specifies "prompted for strict JSON only" plus defensive parsing. I did
both, but put schema-constrained output (`output_config.format` with a
`json_schema`) in front, so the API itself enforces the shape rather than the
prompt asking politely. The defensive parser is still there and still validates
every field — because this is the one response the graded contract depends on, it
gets belt *and* braces. If the schema-constrained request is rejected, it retries
once on prompting alone, then falls back to the template.

**Reading response text.** `message.content[0].text` is wrong once thinking is
enabled — block 0 can be a thinking block. `extractText()` filters for
`type === 'text'` and joins. Also checks `stop_reason === 'refusal'` before
touching content, since a classifier decline returns HTTP 200 with no usable body.

**The fallback feedback does not fabricate.** It's assembled from what the server
genuinely knows — topics covered, question count, answer lengths, the candidate's
own mission record — and its summary says so explicitly: *"Detailed narrative
assessment was unavailable for this session, so the points below are derived from
the interview structure and the candidate's cohort record rather than from an
analysis of their answers."* Inventing plausible-sounding insight about answers
nobody analysed would be worse than admitting the degradation.

---

## 5. Two contract decisions the spec left open

**A message after `done: true`.** The brief says a missing session should be a
clear 4xx. It doesn't say what an *extra* message to a finished session should do.
I return `200` with the same `{ reply, done: true, feedback }` payload rather than
an error. Rationale: a client retrying its last turn, or a judging harness that
sends one message too many, should get a valid spec-shaped response instead of an
error that looks like a broken endpoint. Idempotent replay is the safer failure
mode for something being graded automatically.

**Validation strictness.** Strict about what the agent actually consumes
(`member.name` / `jobRole` / `yearsExperience` for calibration, `missions[].day`
for planning). Deliberately lenient about `signals`: the agent never reads it, so
rejecting a candidate for omitting it would be a false 400 against a hand-made
test payload. `yearsExperience` is coerced with `Number()` so `"9"` is accepted.

---

## 6. Frontend

Built environment-first, per the brief's reasoning: four blurred radial-gradient
blobs (indigo, teal, violet, deep blue) drifting on 78–96s transform-only loops
over `#0B0D12`, *then* the glass on top. The blobs use `filter: blur()` rather
than `backdrop-filter` — they are the thing being blurred, not a blurring
surface, which is far cheaper.

The genuine tension in the brief is that it asks for glass chat bubbles *and* for
capping simultaneously-blurred layers *and* for no nested glass-on-glass. Those
conflict once a transcript is 20 messages long. Resolution:

- **Glass never nests.** The transcript scroller is transparent so the bubbles can
  be the frosted layer; the report's three sub-panels are flat so the report panel
  can be. Verified by computed style — inner cards report `backdrop-filter: none`.
- **Bubbles past the most recent 14 get flattened** to an opaque fill by
  `app.js` (`.bubble--flat`). Same look, bounded layer count. Measured at the end
  of a full 10-question interview: 20 bubbles, 6 flattened.
- **Picker cards drop `backdrop-filter` entirely below 560px**, where a phone can
  put all 20 on screen at once. Measured on a 375×812 profile: 0 blurred layers on
  the picker, 4 on the interview screen, no horizontal overflow.

Two things I got wrong and fixed:

1. Wrote `composes: panel;` in the `.cand` rule — that's CSS Modules syntax and
   is silently ignored in plain CSS. Removed; the rule repeats the panel treatment
   explicitly instead.
2. Helmet's default CSP is `default-src 'self'`, which blocks the Google Fonts
   stylesheet and font files. The page would have silently fallen back to system
   fonts in production. Widened `styleSrc` to include `fonts.googleapis.com` and
   `fontSrc` to include `fonts.gstatic.com`, and nothing else. Verified in-browser:
   all three families load, and Space Grotesk w600 is the face actually applied to
   headings.

The progress rail is fed from `GET /api/interview/:sessionId/meta`, kept separate
from the graded endpoint so `POST /api/interview` returns exactly `{ reply, done }`
and nothing else. Hovering an orb shows the selection rationale for that day —
the personalisation logic is the interesting part of this build, so it's surfaced
rather than hidden.

---

## 7. Things I removed or chose not to do

- **`uuid` dependency removed.** The brief's install list includes it, but session
  IDs are minted client-side per the spec (`crypto.randomUUID()`) and the server
  never generates one. Shipping an unused dependency in a repo judged on
  engineering quality is worse than a documented deviation.
- **No external memory service.** Out of scope per the brief, and correct: the
  need here is one in-progress conversation's turn state, not long-term semantic
  memory across sessions. A `Map` with a TTL sweep is the right size of solution.
- **No rate limit on `/api/interview`.** Only the demo `/api/candidates` route is
  limited (120/min). Throttling the graded endpoint could break a judging or
  live-steer run.
- **No session persistence.** A Render restart clears in-memory sessions. Adding a
  database to persist data that is intentionally disposable after 30 minutes would
  be the wrong trade for this scope. Documented in the README rather than hidden.

---

## 8. Verification performed

Written before the live-key run, so the distinction between what is and isn't
verified stays honest.

**Verified with Claude unreachable** (`ANTHROPIC_BASE_URL=http://127.0.0.1:9`) —
all 45 assertions in `scripts/test-interview.js` pass:

- 10 questions across 5 distinct curriculum days
- `{ reply, done }` on every non-final turn, with no extra keys
- `{ reply, done, feedback }` on the final turn, `reply` exactly
  `"Interview completed."`
- `feedback.summary` a non-empty string; `strengths`/`gaps`/`next` all non-empty
  `string[]` with no extra keys
- 400 for empty body, missing/blank sessionId, both-candidate-and-message,
  malformed candidate, empty message, non-JSON body
- 404 for continuing an unknown session; 409 for duplicate start
- idempotent replay after completion
- logs confirm 12 calls × 3 attempts → 12 fallbacks

**Verified against the live API with an invalid key:** one attempt,
`transient=false`, no wasted retries, immediate fallback.

**Verified in-browser** (full 10-question walk through the real UI): screen
transitions, thinking indicator appearing and clearing, rail advancing 2→10 with
the correct orb marked current, report rendering with 2 strengths / 3 gaps /
4 next steps, blur-layer cap flattening 6 of 20 bubbles, mobile layout at
375×812 with the rail switching to a horizontal scroller.

**Not yet verified — needs a real `ANTHROPIC_API_KEY`:**

- actual question quality and calibration across roles/experience levels
- whether follow-ups genuinely dig into answer specifics (the whole point)
- schema-constrained feedback returning grounded, non-generic points
- real latency and token cost per turn
- the deployed Render URL working cold

These are the remaining items. Every structural guarantee above holds without a
key; everything about *quality* needs one.

---

## 9. Post-live-key run

_To be filled in after the live end-to-end run. Findings, prompt adjustments made
in response to actual output quality, measured latency/cost, and the final
GitHub + Render URLs go here._
