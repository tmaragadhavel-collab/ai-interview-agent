/**
 * Claude wrapper — Anthropic SDK integration for the three generation calls the
 * interview needs (fresh question, follow-up, final feedback).
 *
 * Everything defensive lives here so the route layer can stay a clean state
 * machine:
 *
 *   - per-request timeout, enforced by the SDK (which actually aborts the
 *     request) rather than a Promise.race that leaks a live socket
 *   - retry with exponential backoff + jitter, but ONLY for transient failures.
 *     Retrying a 401 three times just burns 3 seconds and still fails.
 *   - a real fallback for every call, so a Claude outage degrades the interview
 *     instead of ending it
 *   - structured, greppable logging of latency and token usage
 *
 * Prompt discipline: no call sends the full curriculum or the full candidate
 * object. A question call sees one curriculum day plus a one-line summary of the
 * candidate's record on that day; the rolling context is capped at the last few
 * turns. Token cost per turn therefore stays flat as the interview grows instead
 * of climbing quadratically.
 */

const { Anthropic } = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-5';

/** Retry budget: 1 initial attempt + MAX_RETRIES retries. */
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 600;

/**
 * Sonnet 5 introductory pricing (USD per million tokens), current through
 * 2026-08-31; list price after that is 3.00 / 15.00. Used only for the rough
 * cost figure in the logs — nothing branches on it.
 */
const INPUT_USD_PER_MTOK = 2.0;
const OUTPUT_USD_PER_MTOK = 10.0;

/**
 * Call profiles.
 *
 * Question/follow-up calls run with thinking OFF at low effort: the output is
 * two to four sentences, latency is user-visible, and there is no multi-step
 * reasoning to do. This is set explicitly because on Sonnet 5 adaptive thinking
 * is ON when `thinking` is omitted, and `max_tokens` caps thinking *plus*
 * response text — leaving it implicit risks a truncated question.
 *
 * The feedback call is the one genuine judgement task in the app, so it gets
 * adaptive thinking, medium effort, a bigger token budget and a longer timeout.
 */
const PROFILES = {
  question: {
    maxTokens: 1024,
    timeoutMs: 15000,
    thinking: { type: 'disabled' },
    effort: 'low',
  },
  feedback: {
    maxTokens: 3072,
    timeoutMs: 25000,
    thinking: { type: 'adaptive' },
    effort: 'medium',
  },
};

/** JSON Schema for the graded feedback object, enforced server-side by the API. */
const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    next: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'strengths', 'gaps', 'next'],
  additionalProperties: false,
};

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Our own retry loop owns retries. Leaving the SDK's default of 2 in place
      // would multiply with it and turn a 15s timeout into a ~90s worst case.
      maxRetries: 0,
    });
  }
  return client;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is this failure worth retrying?
 *
 * Connection errors and timeouts, 408/409, 429 and 5xx (including 529
 * overloaded) are transient. 400/401/403/404/422 mean the request itself is
 * wrong — a retry produces the identical failure, so fail fast to the fallback.
 */
function isTransient(err) {
  if (err instanceof Anthropic.APIConnectionError) return true; // covers APIConnectionTimeoutError
  const status = err?.status;
  if (typeof status !== 'number') return true; // unknown shape — give it one more try
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

/** Concatenate the text blocks of a response, ignoring thinking blocks. */
function extractText(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Single Claude call with timeout, retry/backoff and structured logging.
 *
 * @returns {Promise<{ok: true, text: string, stopReason: string} | {ok: false, error: string}>}
 *   Never throws — callers pick a fallback based on `ok`.
 */
async function callClaude({ tag, system, prompt, profile, outputFormat = null }) {
  const cfg = PROFILES[profile];
  const outputConfig = { effort: cfg.effort };
  if (outputFormat) outputConfig.format = outputFormat;

  let lastError = 'unknown';

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    const startedAt = Date.now();
    try {
      const message = await getClient().messages.create(
        {
          model: MODEL,
          max_tokens: cfg.maxTokens,
          system,
          thinking: cfg.thinking,
          output_config: outputConfig,
          messages: [{ role: 'user', content: prompt }],
        },
        { timeout: cfg.timeoutMs },
      );

      const latency = Date.now() - startedAt;
      const inTok = message.usage?.input_tokens ?? 0;
      const outTok = message.usage?.output_tokens ?? 0;
      const costUsd =
        (inTok / 1e6) * INPUT_USD_PER_MTOK + (outTok / 1e6) * OUTPUT_USD_PER_MTOK;

      // Safety classifiers return HTTP 200 with stop_reason "refusal" and no
      // usable content, so this has to be checked before reading the text.
      if (message.stop_reason === 'refusal') {
        console.log(
          `[claude] tag=${tag} attempt=${attempt}/${MAX_RETRIES + 1} status=refusal ` +
            `latency_ms=${latency} category=${message.stop_details?.category ?? 'null'}`,
        );
        return { ok: false, error: 'refusal' };
      }

      const text = extractText(message);
      console.log(
        `[claude] tag=${tag} attempt=${attempt}/${MAX_RETRIES + 1} status=ok ` +
          `latency_ms=${latency} in_tok=${inTok} out_tok=${outTok} ` +
          `est_cost_usd=${costUsd.toFixed(5)} stop=${message.stop_reason} chars=${text.length}`,
      );

      if (!text) {
        // Empty body with a non-refusal stop reason: usually thinking consumed
        // the whole budget. Retrying is pointless (same budget), so degrade.
        return { ok: false, error: `empty response (stop=${message.stop_reason})` };
      }
      return { ok: true, text, stopReason: message.stop_reason };
    } catch (err) {
      const latency = Date.now() - startedAt;
      const transient = isTransient(err);
      lastError = err?.message || String(err);
      console.log(
        `[claude] tag=${tag} attempt=${attempt}/${MAX_RETRIES + 1} status=error ` +
          `latency_ms=${latency} http_status=${err?.status ?? 'none'} ` +
          `transient=${transient} error="${lastError.replace(/"/g, "'")}"`,
      );

      if (!transient) break;
      if (attempt <= MAX_RETRIES) {
        // Exponential backoff with jitter so concurrent sessions don't retry in lockstep.
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 250;
        await sleep(Math.round(delay));
      }
    }
  }

  console.log(`[claude] tag=${tag} status=exhausted using_fallback=true`);
  return { ok: false, error: lastError };
}

// ------------------------------------------------------------- system prompt

function buildSystemPrompt(member) {
  return (
    `You are a senior technical interviewer for an enterprise AI engineering hiring pipeline. ` +
    `You're interviewing ${member.name}, a ${member.jobRole} with ${member.yearsExperience} years experience, ` +
    `who just completed a 31-day AI Cohort program covering RAG, vector databases, prompt engineering, ` +
    `agentic AI, MCP, and production AI systems. Your job: assess real understanding, not memorized definitions. ` +
    `Be warm but rigorous — like a good senior engineer conducting a bar-raising interview. ` +
    `Ask one question at a time, 2-4 sentences, no preamble. When following up, dig into specifics of their ` +
    `previous answer. Never lecture; you're assessing, not teaching.`
  );
}

/**
 * The candidate's record on a topic, phrased as calibration guidance.
 *
 * Deliberately framed as instructions to the interviewer rather than as data:
 * the model must let this set the difficulty and angle of the question, not read
 * the candidate's own scorecard back to them.
 */
function calibrationNote(topic) {
  const md = topic.missionData;
  if (!md) {
    return 'No record for this day. Treat it as a general-knowledge probe and keep expectations open.';
  }
  if (md.skipped) {
    return 'They skipped this mission entirely, so assume little or no hands-on experience. Probe for baseline conceptual understanding rather than implementation detail.';
  }
  if (md.passed === false) {
    return `They attempted this mission ${md.attempts ?? 'several'} time(s) and did not pass, so expect partial understanding with real gaps. Find the boundary of what they actually grasp.`;
  }
  if ((md.attempts ?? 1) >= 3) {
    return `They passed only after ${md.attempts} attempts, so the fundamentals are probably there but the deeper reasoning may not be. Push past the surface.`;
  }
  if (md.attempts === 2) {
    return 'They passed on the second attempt — minor friction. A standard-difficulty question is appropriate.';
  }
  return 'They passed this on the first attempt. Assume competence and go deeper than surface level to confirm real understanding rather than familiarity.';
}

/** Compact the rolling context to the last few turns to keep prompts flat-sized. */
function formatRecentTurns(transcript, limit = 4) {
  return transcript
    .slice(-limit)
    .map((t) => `${t.role === 'interviewer' ? 'You' : 'Candidate'}: ${t.content}`)
    .join('\n');
}

// ------------------------------------------------------- 1. opening greeting

async function generateWelcome(member) {
  const result = await callClaude({
    tag: 'welcome',
    system: buildSystemPrompt(member),
    profile: 'question',
    prompt:
      `Greet ${member.name} in 1-2 sentences and say you'll be talking through their work in the AI Cohort ` +
      `program. Do not list any topics, do not ask a question, and do not say "let's begin" — the first ` +
      `question is appended separately. Warm and professional, no filler.`,
  });

  if (result.ok) return result.text;
  return (
    `Thanks for making the time, ${member.name}. I'd like to talk through some of the work you did ` +
    `during the AI Cohort program and dig into how you approached it.`
  );
}

// -------------------------------------------------------- 2. fresh question

async function generateQuestion(member, topic, questionNumber, transcript = []) {
  const recent = formatRecentTurns(transcript);

  const result = await callClaude({
    tag: 'question',
    system: buildSystemPrompt(member),
    profile: 'question',
    prompt:
      `This is question ${questionNumber} of the interview, and it opens a new topic.\n\n` +
      `TOPIC — Day ${topic.day}: "${topic.title}" (${topic.type})\n` +
      `Tools covered: ${topic.tools.length ? topic.tools.join(', ') : 'n/a'}\n` +
      `Learning objectives:\n${topic.objectives.map((o) => `  - ${o}`).join('\n') || '  - n/a'}\n\n` +
      `CALIBRATION (private — this shapes the difficulty and angle of your question. ` +
      `Never state or hint at their mission record to the candidate):\n${calibrationNote(topic)}\n\n` +
      (recent ? `RECENT CONVERSATION (for continuity of tone only):\n${recent}\n\n` : '') +
      `Ask one specific technical question on this topic, pitched at a ${member.jobRole} with ` +
      `${member.yearsExperience} years of experience. 2-4 sentences. Output only the question itself — ` +
      `no preamble, no "great answer", no topic announcement.`,
  });

  if (result.ok) return result.text;
  return fallbackQuestion(topic);
}

/**
 * Pre-written per-type question templates, used when Claude is unreachable.
 * Every `type` present in curriculum.json has an entry; BUILD is the default.
 */
function fallbackQuestion(topic) {
  const templates = {
    SETUP: `Walk me through how you'd set up and verify a working environment for ${topic.title} on a new machine. What tends to go wrong, and how would you catch it early?`,
    BUILD: `Walk me through how you'd approach ${topic.title} in a production system. What are the key design decisions, and what trade-offs would you be weighing?`,
    AI_CORE: `Explain the core ideas behind ${topic.title} as you understand them, and then tell me how you'd apply them inside a real retrieval pipeline.`,
    LEARN: `What are the most important things you took away from ${topic.title}? Compare the main approaches and tell me when you'd reach for each one.`,
    SHIP_IT: `Describe how you'd take ${topic.title} from working locally to actually shipped. Which steps do people most often skip, and what breaks when they do?`,
    OPTIMIZE: `For ${topic.title}, what would you measure in production, and what trade-offs would you accept to move those numbers?`,
    CAPSTONE: `Tell me how you approached ${topic.title}. How did you integrate the separate pieces you'd learned across the cohort, and what would you rebuild differently?`,
  };
  return templates[topic.type] || templates.BUILD;
}

// ----------------------------------------------------------- 3. follow-up

async function generateFollowUp(member, topic, previousQuestion, candidateAnswer) {
  const result = await callClaude({
    tag: 'followup',
    system: buildSystemPrompt(member),
    profile: 'question',
    prompt:
      `You are still on Day ${topic.day}: "${topic.title}".\n\n` +
      `You asked:\n"${previousQuestion}"\n\n` +
      `They answered, verbatim:\n"${candidateAnswer}"\n\n` +
      `Ask exactly one probing follow-up that could only be asked of THIS answer. Pick whichever fits ` +
      `best: challenge an assumption they made, ask for a concrete example of something they described ` +
      `abstractly, ask why they chose one approach over an alternative, or push on a case their answer ` +
      `wouldn't handle. If the answer was thin or evasive, narrow the question rather than moving on. ` +
      `2-4 sentences, no preamble, no evaluation of their answer — just the follow-up.`,
  });

  if (result.ok) return result.text;
  return (
    `Can you make that concrete for me? Walk me through a specific instance from your work on ` +
    `${topic.title} — what you actually did, what went wrong, and how you resolved it.`
  );
}

// ------------------------------------------------------- 4. final feedback

/** Condense the transcript to topic-grouped Q/A pairs — never the raw history. */
function condenseTranscript(plan, transcript) {
  const lines = [];
  let lastDay = null;
  for (const entry of transcript) {
    const topic = plan[entry.topicIndex];
    if (topic && topic.day !== lastDay) {
      lastDay = topic.day;
      lines.push(`\n[Day ${topic.day} — ${topic.title}]`);
    }
    lines.push(`${entry.role === 'interviewer' ? 'Q' : 'A'}: ${entry.content}`);
  }
  return lines.join('\n').trim();
}

async function generateFeedback(member, plan, transcript) {
  const questionCount = transcript.filter((t) => t.role === 'interviewer').length;
  const topicList = plan.map((t) => `Day ${t.day} (${t.title})`).join(', ');

  const prompt =
    `The interview is complete. Here is the condensed transcript:\n\n` +
    `${condenseTranscript(plan, transcript)}\n\n` +
    `Topics covered: ${topicList}\n` +
    `Questions asked: ${questionCount}\n\n` +
    `Write the candidate's assessment as a JSON object with exactly these keys:\n` +
    `  "summary"   — 2-3 sentences on their overall level and how they reason.\n` +
    `  "strengths" — 2-4 items, each citing something specific they actually said.\n` +
    `  "gaps"      — 2-4 items, each tied to a specific topic or answer where they fell short.\n` +
    `  "next"      — 2-4 concrete, actionable next steps that follow from those gaps.\n\n` +
    `Every array item must reference this interview. No generic advice that could apply to any ` +
    `candidate ("keep practising", "learn more about AI") — if you cannot ground a point in something ` +
    `they said, leave it out. Be honest: if an answer was weak, say so plainly. Output JSON only.`;

  const system = buildSystemPrompt(member);

  // Preferred path: the API enforces the schema, so the response cannot be
  // malformed JSON or carry stray prose.
  let result = await callClaude({
    tag: 'feedback',
    system,
    prompt,
    profile: 'feedback',
    outputFormat: { type: 'json_schema', schema: FEEDBACK_SCHEMA },
  });

  // If schema-constrained output was rejected outright (unsupported on this
  // account/SDK), retry once relying on the prompt alone. The defensive parse
  // below then does the work.
  if (!result.ok && /output_config|json_schema|format/i.test(result.error || '')) {
    console.log('[claude] tag=feedback structured_output_rejected=true retrying_prompt_only=true');
    result = await callClaude({ tag: 'feedback-plain', system, prompt, profile: 'feedback' });
  }

  if (result.ok) {
    const parsed = parseFeedback(result.text);
    if (parsed) return parsed;
    console.log('[claude] tag=feedback parse_failed=true using_fallback=true');
  }

  return fallbackFeedback(member, plan, transcript);
}

/**
 * Parse and validate the feedback payload.
 *
 * Defensive even with schema-enforced output: this is the one response whose
 * shape the graded API contract depends on, so it is validated rather than
 * trusted. Strips markdown fences, tolerates leading prose, coerces item types,
 * and returns null on anything it cannot vouch for.
 */
function parseFeedback(text) {
  let raw = text.trim();

  // ```json ... ``` fences
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) raw = fenced[1].trim();

  // Fall back to the outermost {...} span if the model wrapped the object in prose.
  if (!raw.startsWith('{')) {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first === -1 || last <= first) return null;
    raw = raw.slice(first, last + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.log(`[claude] feedback JSON.parse failed: ${err.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  // Keep only non-empty strings; the contract promises string[].
  const toStringArray = (value) =>
    Array.isArray(value)
      ? value
          .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
          .filter(Boolean)
      : [];

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const strengths = toStringArray(parsed.strengths);
  const gaps = toStringArray(parsed.gaps);
  const next = toStringArray(parsed.next);

  // A payload missing the summary or with every array empty is not usable
  // feedback — fall back rather than return a hollow object.
  if (!summary || (!strengths.length && !gaps.length && !next.length)) return null;

  return { summary, strengths, gaps, next };
}

/**
 * Feedback assembled from what the server knows without the model: which topics
 * were covered, how many questions were asked, and the candidate's own mission
 * record. Less insightful than the generated version, but always valid and never
 * fabricated.
 */
function fallbackFeedback(member, plan, transcript) {
  const questionCount = transcript.filter((t) => t.role === 'interviewer').length;
  const answers = transcript.filter((t) => t.role === 'candidate');
  const avgAnswerChars = answers.length
    ? Math.round(answers.reduce((sum, a) => sum + a.content.length, 0) / answers.length)
    : 0;

  const strong = plan.filter((t) => t.missionData && t.score <= 10);
  const struggled = plan.filter((t) => t.score >= 50);
  const skipped = plan.filter((t) => t.missionData?.skipped);

  const strengths = strong.length
    ? strong.map(
        (t) => `Cleared Day ${t.day} (${t.title}) on the first attempt during the cohort and was able to discuss it here.`,
      )
    : [`Worked through all ${questionCount} questions across ${plan.length} curriculum topics without disengaging.`];

  const gaps = struggled.length
    ? struggled.map((t) => `Day ${t.day} (${t.title}) — ${t.reason}. Worth revisiting in depth.`)
    : [`No single topic stood out as a weakness from the cohort record; a deeper technical screen would be needed to differentiate.`];

  const next = [
    ...(skipped.length
      ? [`Complete the skipped mission(s): ${skipped.map((t) => `Day ${t.day} ${t.title}`).join(', ')}.`]
      : []),
    ...(struggled.length
      ? [`Rebuild ${struggled[struggled.length - 1].title} from scratch without reference material to close the gap.`]
      : []),
    'Ship one end-to-end project that chains retrieval, prompting and an agent loop, then write up the trade-offs made.',
    'Practise narrating design decisions aloud — stating the alternative rejected and why.',
  ].slice(0, 4);

  return {
    summary:
      `${member.name} (${member.jobRole}, ${member.yearsExperience}y) completed a ${questionCount}-question ` +
      `interview spanning ${plan.length} days of the AI Cohort curriculum, averaging ${avgAnswerChars} ` +
      `characters per answer. Detailed narrative assessment was unavailable for this session, so the ` +
      `points below are derived from the interview structure and the candidate's cohort record rather ` +
      `than from an analysis of their answers.`,
    strengths,
    gaps,
    next,
  };
}

module.exports = {
  generateWelcome,
  generateQuestion,
  generateFollowUp,
  generateFeedback,
  // exported for tests
  parseFeedback,
  fallbackFeedback,
  fallbackQuestion,
  MODEL,
};
