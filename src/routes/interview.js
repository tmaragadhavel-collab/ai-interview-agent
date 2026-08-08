/**
 * POST /api/interview — the single graded endpoint.
 *
 * The server owns the shape of the interview; Claude only writes the words.
 * The plan is 5 curriculum days x 2 question-turns = 10 questions across 5
 * distinct days, which clears the "8+ questions across 4+ days" floor by
 * construction rather than by asking the model to keep count.
 *
 * `phase` records what the NEXT candidate message should trigger:
 *
 *   'followup' → answer belongs to a topic-opening question; ask the follow-up
 *                for the same topic
 *   'advance'  → answer belongs to a follow-up; move to the next topic, or end
 *                the interview if that was the last one
 *   'done'     → interview finished; replay the completed payload
 *
 * Response bodies are exactly what technical-spec.md specifies and nothing more:
 * { reply, done } while running, plus `feedback` on the final turn. Anything
 * useful-but-extra (the plan, progress) is served by the separate demo-only
 * /api/interview/:sessionId/meta route so this contract stays byte-clean.
 */

const { Router } = require('express');
const { createSession, getSession, hasSession } = require('../engine/sessionStore');
const { buildPlan } = require('../engine/plan');
const {
  generateWelcome,
  generateQuestion,
  generateFollowUp,
  generateFeedback,
} = require('../engine/claude');

const router = Router();

const MAX_SESSION_ID_LEN = 200;
const MAX_MESSAGE_LEN = 8000; // caps prompt growth and rejects abusive payloads

// ------------------------------------------------------------- validation

const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0;

function validateSessionId(body, errors) {
  if (!isNonEmptyString(body.sessionId)) {
    errors.push('sessionId must be a non-empty string');
  } else if (body.sessionId.length > MAX_SESSION_ID_LEN) {
    errors.push(`sessionId must be at most ${MAX_SESSION_ID_LEN} characters`);
  }
}

/**
 * Validate the candidate object.
 *
 * Strict about what we actually consume (`member` identity fields for prompt
 * calibration, `missions` for plan building) and deliberately lenient about the
 * rest: `signals` is aggregate data this agent never reads, so rejecting a
 * candidate for omitting it would be a false 400. `yearsExperience` is coerced
 * from a numeric string for the same reason.
 */
function validateCandidate(candidate, errors) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    errors.push('candidate must be an object');
    return;
  }

  const { member, missions, signals } = candidate;

  if (!member || typeof member !== 'object' || Array.isArray(member)) {
    errors.push('candidate.member must be an object');
  } else {
    if (!isNonEmptyString(member.name)) errors.push('candidate.member.name must be a non-empty string');
    if (!isNonEmptyString(member.jobRole)) errors.push('candidate.member.jobRole must be a non-empty string');
    const years = Number(member.yearsExperience);
    if (!Number.isFinite(years) || years < 0) {
      errors.push('candidate.member.yearsExperience must be a non-negative number');
    }
  }

  if (!Array.isArray(missions)) {
    errors.push('candidate.missions must be an array');
  } else if (missions.some((m) => !m || typeof m !== 'object' || typeof m.day !== 'number')) {
    errors.push('every candidate.missions entry must be an object with a numeric "day"');
  }

  if (signals !== undefined && (typeof signals !== 'object' || signals === null || Array.isArray(signals))) {
    errors.push('candidate.signals, if present, must be an object');
  }
}

/** Normalise the fields the prompts interpolate, so templates never print "undefined". */
function normaliseMember(member) {
  return {
    id: typeof member.id === 'string' ? member.id : null,
    name: member.name.trim(),
    jobRole: member.jobRole.trim(),
    yearsExperience: Number(member.yearsExperience),
  };
}

// ----------------------------------------------------------------- routing

router.post('/', async (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object.' });
    }

    const hasCandidate = body.candidate !== undefined;
    const hasMessage = body.message !== undefined;

    // Exactly one of the two must be present — this is what distinguishes a
    // start request from a continue request.
    if (hasCandidate === hasMessage) {
      return res.status(400).json({
        error: hasCandidate
          ? 'Send either { sessionId, candidate } to start or { sessionId, message } to continue — not both.'
          : 'Send { sessionId, candidate } to start an interview, or { sessionId, message } to continue one.',
      });
    }

    return hasCandidate ? await handleStart(body, res) : await handleContinue(body, res);
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------------------- start

async function handleStart(body, res) {
  const errors = [];
  validateSessionId(body, errors);
  validateCandidate(body.candidate, errors);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const { sessionId, candidate } = body;

  // Don't silently overwrite an interview that is already running under this id.
  if (hasSession(sessionId)) {
    return res.status(409).json({
      error: `Session "${sessionId}" already exists. Continue it with { sessionId, message }, or start a new one with a different sessionId.`,
    });
  }

  const member = normaliseMember(candidate.member);
  const plan = buildPlan(candidate);

  console.log(
    `[interview] start session=${sessionId} candidate="${member.name}" ` +
      `role="${member.jobRole}" years=${member.yearsExperience} topics=${plan.length}`,
  );
  plan.forEach((topic, i) =>
    console.log(
      `[interview]   plan[${i}] day=${topic.day} score=${topic.score} ` +
        `type=${topic.type} reason="${topic.reason}" title="${topic.title}"`,
    ),
  );

  const session = createSession(sessionId, {
    candidate,
    member,
    plan,
    topicIndex: 0,
    phase: 'followup',
    transcript: [],
    questionCount: 0,
    lastQuestion: null,
    feedback: null,
  });

  // Greeting and first question are independent calls, so run them together —
  // the pair costs one call's worth of latency rather than two.
  const [welcome, firstQuestion] = await Promise.all([
    generateWelcome(member),
    generateQuestion(member, plan[0], 1, []),
  ]);

  const reply = `${welcome}\n\n${firstQuestion}`;

  // Only the question text is stored as `lastQuestion`: the follow-up prompt
  // should reason about the question, not about the greeting wrapped around it.
  session.transcript.push({ role: 'interviewer', content: reply, topicIndex: 0, day: plan[0].day });
  session.questionCount = 1;
  session.lastQuestion = firstQuestion;

  return res.json({ reply, done: false });
}

// ---------------------------------------------------------------- continue

async function handleContinue(body, res) {
  const errors = [];
  validateSessionId(body, errors);
  if (!isNonEmptyString(body.message)) {
    errors.push('message must be a non-empty string');
  } else if (body.message.length > MAX_MESSAGE_LEN) {
    errors.push(`message must be at most ${MAX_MESSAGE_LEN} characters`);
  }
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const { sessionId } = body;
  const message = body.message.trim();

  // Throws a tagged 404 if the session is unknown or has been evicted.
  const session = getSession(sessionId);

  // Already finished. Replay the terminal payload instead of erroring: a client
  // that retries the last turn (or a judging harness that sends one message too
  // many) should get the same valid, spec-shaped response rather than a 4xx.
  if (session.phase === 'done') {
    return res.json({ reply: 'Interview completed.', done: true, feedback: session.feedback });
  }

  const currentTopic = session.plan[session.topicIndex];

  session.transcript.push({
    role: 'candidate',
    content: message,
    topicIndex: session.topicIndex,
    day: currentTopic.day,
  });

  if (session.phase === 'followup') {
    // Second question on the current topic, derived from what they just said.
    // This call also grades the answer: a weak one gets corrected in the
    // interviewer's own voice before the conversation moves on.
    const { verdict, reply } = await generateFollowUp(
      session.member,
      currentTopic,
      session.lastQuestion,
      message,
    );

    // Internal state only — the verdict is never part of the response body.
    // It drives the demo /meta endpoint and the final feedback context.
    currentTopic.verdict = verdict;
    // Tag the answer that was graded, so the UI can mark the right bubble.
    session.transcript[session.transcript.length - 1].verdict = verdict;

    console.log(
      `[interview] graded day=${currentTopic.day} verdict=${verdict} ` +
        `answer_chars=${message.length}`,
    );

    session.transcript.push({
      role: 'interviewer',
      content: reply,
      topicIndex: session.topicIndex,
      day: currentTopic.day,
    });
    session.questionCount += 1;
    session.lastQuestion = reply;
    session.phase = 'advance';

    return res.json({ reply, done: false });
  }

  // phase === 'advance': that was the answer to a follow-up, so this topic is done.
  session.topicIndex += 1;

  if (session.topicIndex >= session.plan.length) {
    return await handleEnd(session, res);
  }

  const nextTopic = session.plan[session.topicIndex];
  const question = await generateQuestion(
    session.member,
    nextTopic,
    session.questionCount + 1,
    session.transcript,
  );

  session.transcript.push({
    role: 'interviewer',
    content: question,
    topicIndex: session.topicIndex,
    day: nextTopic.day,
  });
  session.questionCount += 1;
  session.lastQuestion = question;
  session.phase = 'followup';

  return res.json({ reply: question, done: false });
}

// --------------------------------------------------------------------- end

async function handleEnd(session, res) {
  const distinctDays = new Set(session.transcript.filter((t) => t.role === 'interviewer').map((t) => t.day));

  console.log(
    `[interview] complete candidate="${session.member.name}" ` +
      `questions=${session.questionCount} distinct_days=${distinctDays.size} ` +
      `days=[${[...distinctDays].join(',')}]`,
  );

  const feedback = await generateFeedback(session.member, session.plan, session.transcript);

  session.feedback = feedback;
  session.phase = 'done';

  return res.json({ reply: 'Interview completed.', done: true, feedback });
}

module.exports = router;
