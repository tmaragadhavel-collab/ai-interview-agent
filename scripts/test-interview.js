#!/usr/bin/env node
/**
 * End-to-end contract test against a running server.
 *
 *   node server.js                     # in one terminal
 *   node scripts/test-interview.js     # in another
 *
 * Walks a complete interview and asserts every requirement of the graded
 * contract, then exercises the input-validation and session-guard paths.
 *
 * Env:
 *   BASE_URL     default http://localhost:3000
 *   CANDIDATE_ID default CAND-001  (try CAND-003 all-pass or CAND-017 all-struggle)
 *
 * This is also the offline safety net: run the server with a deliberately
 * broken ANTHROPIC_BASE_URL or API key and every assertion below must still
 * pass, proving the fallbacks keep the contract intact when Claude is
 * unreachable. See README, "Verifying the fallbacks".
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CANDIDATE_ID = process.env.CANDIDATE_ID || 'CAND-001';
const MAX_TURNS = 40;

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function post(body) {
  const res = await fetch(`${BASE_URL}/api/interview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body is itself a failure, reported by the caller */
  }
  return { status: res.status, json };
}

/** Plausible-but-varied answers, so follow-ups have real material to dig into. */
const ANSWERS = [
  "I'd start by chunking the source documents at around 500 tokens with a 50-token overlap, embed them with a sentence-transformer model, and store the vectors in a managed index. At query time I embed the question, pull the top 5 by cosine similarity, and pass them as context.",
  "Honestly, I picked 500 tokens because that's what the cohort material used. I didn't benchmark it against other sizes, so I can't defend it beyond it working well enough for our test set.",
  "I'd measure recall@k against a labelled set of question-passage pairs, and separately track how often the generated answer cites the retrieved passage. Latency at p95 matters too, because the retrieval step sat in the request path.",
  "The failure case I hit was multi-hop questions — where the answer needs two passages that don't individually look relevant to the query. Pure top-k similarity misses those entirely.",
  "For the agent loop I kept a running message list and appended each tool result back before the next call. I capped it at ten iterations so a confused agent couldn't spin forever.",
  "I did not add retries around the tool calls initially, and that bit me: one flaky HTTP call would abort the whole run. I added backoff afterwards.",
  "MCP was the piece I understood least. I know it standardises how a model discovers and calls external tools, so you're not writing a bespoke adapter per integration, but I never built a server myself.",
  "If I were doing it again I'd write a small MCP server over our internal search API, mostly so the tool surface is described once instead of duplicated in every prompt.",
  "For deployment I containerised the service and ran it behind a single replica. Config came from environment variables, and I kept the model name configurable so we could swap it without a rebuild.",
  "The thing I'd fix is observability — I had print statements, not structured logs, so when latency spiked I couldn't tell whether it was retrieval or generation without reproducing locally.",
  'I would need to think about that more carefully before giving you a confident answer.',
];

async function main() {
  console.log(`\nTarget: ${BASE_URL}   Candidate: ${CANDIDATE_ID}\n`);

  // ---------------------------------------------------------------- health
  console.log('Health & demo endpoints');
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  check('GET /health returns ok', health.status === 'ok', JSON.stringify(health));

  const list = await fetch(`${BASE_URL}/api/candidates`).then((r) => r.json());
  check('GET /api/candidates returns 20 candidates', list.candidates?.length === 20);
  check(
    'candidate list exposes id/name/jobRole/yearsExperience/level/domain',
    list.candidates.every(
      (c) => Object.keys(c).sort().join(',') === 'domain,id,jobRole,level,name,yearsExperience',
    ),
    JSON.stringify(list.candidates[0]),
  );

  const LEVELS = ['Entry', 'Mid', 'Senior', 'Staff+'];
  const DOMAINS = ['AI/ML', 'Data', 'DevOps', 'Mobile', 'Design', 'Business', 'IT/Support', 'Engineering', 'General'];
  check(
    'every candidate has a level from the known set',
    list.candidates.every((c) => LEVELS.includes(c.level)),
    JSON.stringify([...new Set(list.candidates.map((c) => c.level))]),
  );
  check(
    'every candidate has a domain from the known set',
    list.candidates.every((c) => DOMAINS.includes(c.domain)),
    JSON.stringify([...new Set(list.candidates.map((c) => c.domain))]),
  );
  // Title keywords must beat raw years — the whole point of the override rules.
  const intern = list.candidates.find((c) => /intern/i.test(c.jobRole));
  const distinguished = list.candidates.find((c) => /distinguished/i.test(c.jobRole));
  check(
    `"${intern?.jobRole}" (${intern?.yearsExperience}y) → Entry via title override`,
    intern?.level === 'Entry',
    intern?.level,
  );
  check(
    `"${distinguished?.jobRole}" → Staff+ via title override`,
    distinguished?.level === 'Staff+',
    distinguished?.level,
  );

  const detail = await fetch(`${BASE_URL}/api/candidates/${CANDIDATE_ID}`).then((r) => r.json());
  check('GET /api/candidates/:id returns full candidate', !!detail.candidate?.missions);
  const candidate = detail.candidate;

  // ----------------------------------------------------------- validation
  console.log('\nInput validation (must be 4xx, never 5xx)');
  check('empty body → 400', (await post({})).status === 400);
  check('missing sessionId → 400', (await post({ candidate })).status === 400);
  check('blank sessionId → 400', (await post({ sessionId: '   ', candidate })).status === 400);
  check(
    'both candidate and message → 400',
    (await post({ sessionId: 'x', candidate, message: 'hi' })).status === 400,
  );
  check(
    'candidate missing member → 400',
    (await post({ sessionId: 'x', candidate: { missions: [] } })).status === 400,
  );
  check(
    'unknown session on continue → 404',
    (await post({ sessionId: `ghost-${Date.now()}`, message: 'hello' })).status === 404,
  );
  check('empty message → 400', (await post({ sessionId: 'x', message: '' })).status === 400);

  const badJson = await fetch(`${BASE_URL}/api/interview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  check('malformed JSON → 400', badJson.status === 400, `got ${badJson.status}`);

  // ---------------------------------------------------------------- start
  console.log('\nInterview flow');
  const sessionId = `test-${Date.now()}`;
  const start = await post({ sessionId, candidate });
  check('start → 200', start.status === 200, `got ${start.status}`);
  check('start reply is a non-empty string', typeof start.json?.reply === 'string' && start.json.reply.length > 0);
  check('start done === false', start.json?.done === false);
  check(
    'start response has exactly {reply, done}',
    Object.keys(start.json).sort().join(',') === 'done,reply',
    Object.keys(start.json).join(','),
  );

  const dup = await post({ sessionId, candidate });
  check('duplicate start → 409 (no silent overwrite)', dup.status === 409, `got ${dup.status}`);

  // ------------------------------------------------------------ the turns
  const replies = [start.json.reply];
  let done = false;
  let feedback = null;
  let turns = 0;

  while (!done && turns < MAX_TURNS) {
    const answer = ANSWERS[turns % ANSWERS.length];
    const res = await post({ sessionId, message: answer });
    turns += 1;

    if (res.status !== 200) {
      check(`turn ${turns} → 200`, false, `got ${res.status} ${JSON.stringify(res.json)}`);
      break;
    }
    if (typeof res.json.reply !== 'string' || !res.json.reply.length) {
      check(`turn ${turns} reply is a non-empty string`, false, JSON.stringify(res.json));
      break;
    }

    if (res.json.done === true) {
      done = true;
      feedback = res.json.feedback;
      check(
        'final response has exactly {reply, done, feedback}',
        Object.keys(res.json).sort().join(',') === 'done,feedback,reply',
        Object.keys(res.json).join(','),
      );
      check("final reply is exactly 'Interview completed.'", res.json.reply === 'Interview completed.', res.json.reply);
    } else {
      check(
        `turn ${turns} response has exactly {reply, done}`,
        Object.keys(res.json).sort().join(',') === 'done,reply',
        Object.keys(res.json).join(','),
      );
      replies.push(res.json.reply);
    }
  }

  check('interview terminated on its own', done, `still running after ${MAX_TURNS} turns`);

  // -------------------------------------------------- coverage assertions
  console.log('\nCoverage requirements');
  const meta = await fetch(`${BASE_URL}/api/interview/${sessionId}/meta`).then((r) => r.json());
  const days = new Set(meta.plan.map((t) => t.day));

  check(`>= 8 questions asked (got ${replies.length})`, replies.length >= 8);
  check(`>= 4 distinct curriculum days (got ${days.size}: ${[...days].join(',')})`, days.size >= 4);
  check('every planned day exists in curriculum 1..31', [...days].every((d) => d >= 1 && d <= 31));
  check('meta reports the interview as done', meta.done === true);
  check('every question is distinct text', new Set(replies).size === replies.length);

  // -------------------------------------------------- feedback assertions
  console.log('\nFeedback schema');
  check('feedback is an object', feedback && typeof feedback === 'object');
  check('summary is a non-empty string', typeof feedback?.summary === 'string' && feedback.summary.trim().length > 0);
  for (const key of ['strengths', 'gaps', 'next']) {
    check(`${key} is an array`, Array.isArray(feedback?.[key]));
    check(
      `${key} contains only non-empty strings`,
      Array.isArray(feedback?.[key]) &&
        feedback[key].length > 0 &&
        feedback[key].every((s) => typeof s === 'string' && s.trim().length > 0),
      JSON.stringify(feedback?.[key]),
    );
  }
  check(
    'feedback has no extra keys',
    feedback && Object.keys(feedback).sort().join(',') === 'gaps,next,strengths,summary',
    Object.keys(feedback || {}).join(','),
  );

  // --------------------------------------------------------- idempotency
  console.log('\nPost-completion behaviour');
  const after = await post({ sessionId, message: 'anything else?' });
  check('extra message after done → 200 with same terminal payload', after.status === 200 && after.json?.done === true);
  check(
    'replayed feedback is identical',
    JSON.stringify(after.json?.feedback) === JSON.stringify(feedback),
  );

  // ------------------------------------------------------------- summary
  console.log('\n' + '─'.repeat(60));
  if (failures.length === 0) {
    console.log(`\x1b[32mALL ${passed} CHECKS PASSED\x1b[0m  (${replies.length} questions, ${days.size} days)`);
  } else {
    console.log(`\x1b[31m${failures.length} FAILED\x1b[0m, ${passed} passed:`);
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('─'.repeat(60) + '\n');

  console.log('Sample feedback:\n' + JSON.stringify(feedback, null, 2) + '\n');

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n[test] fatal: ${err.message}`);
  console.error('Is the server running?  node server.js');
  process.exit(1);
});
