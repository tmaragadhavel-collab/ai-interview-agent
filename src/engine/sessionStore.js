/**
 * Session Store — in-memory Map wrapper with TTL eviction.
 *
 * The interview is a multi-request state machine: each HTTP call advances one
 * turn, so the process must hold per-session state between calls. That is the
 * reason this app is a long-running Express process rather than a serverless
 * function (see README, "Why Express + Render").
 *
 * Guarantees this module provides to the route layer:
 *   - `create` refuses to overwrite an existing session (409, not silent clobber)
 *   - `get` throws a tagged 404 rather than returning undefined for the caller
 *     to trip over
 *   - idle sessions are evicted so memory stays bounded across a long judging
 *     window
 */

const SESSION_TTL_MS = 30 * 60 * 1000; // evict sessions idle > 30 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // check once a minute

/** @type {Map<string, SessionState>} */
const sessions = new Map();

/**
 * @typedef {Object} SessionState
 * @property {Object}  candidate     Candidate object exactly as received
 * @property {Array}   plan          Ordered interview plan (see engine/plan.js)
 * @property {number}  topicIndex    Index into `plan` of the topic in progress
 * @property {'followup'|'advance'|'done'} phase  What the NEXT candidate message triggers
 * @property {Array}   transcript    [{ role, content, topicIndex, day }]
 * @property {number}  questionCount Questions asked so far
 * @property {string?} lastQuestion  Last question asked, verbatim (for follow-up prompts)
 * @property {Object?} feedback      Final feedback, cached once generated
 * @property {number}  createdAt     Epoch ms
 * @property {number}  lastActivity  Epoch ms, bumped on every access
 */

/** Error helper so the route layer can map failures to status codes. */
function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Register a new session. Throws 409 if the id is already in use — an accidental
 * re-POST of a start request must not wipe an interview that is underway.
 */
function createSession(sessionId, state) {
  if (sessions.has(sessionId)) {
    throw httpError(`Session "${sessionId}" already exists.`, 409);
  }
  const now = Date.now();
  sessions.set(sessionId, { ...state, createdAt: now, lastActivity: now });
  return sessions.get(sessionId);
}

/** Fetch a session, bumping its idle timer. Throws 404 if unknown or evicted. */
function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw httpError(
      `Session "${sessionId}" not found. Start an interview by POSTing { sessionId, candidate } first.`,
      404,
    );
  }
  session.lastActivity = Date.now();
  return session;
}

/** Non-throwing existence check, for the "already exists" guard on start. */
function hasSession(sessionId) {
  return sessions.has(sessionId);
}

/** Read-only peek that does NOT bump the idle timer — for demo/meta endpoints. */
function peekSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function deleteSession(sessionId) {
  return sessions.delete(sessionId);
}

function sessionCount() {
  return sessions.size;
}

// ---------------------------------------------------------------- TTL sweep

/** Evict idle sessions. Exported so it can be driven directly in tests. */
function sweepExpiredSessions(now = Date.now()) {
  let evicted = 0;
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
      evicted += 1;
    }
  }
  if (evicted > 0) {
    console.log(`[session-store] evicted=${evicted} active=${sessions.size}`);
  }
  return evicted;
}

// `unref` so an idle timer never holds the process open on shutdown.
const sweepTimer = setInterval(sweepExpiredSessions, SWEEP_INTERVAL_MS);
sweepTimer.unref();

module.exports = {
  createSession,
  getSession,
  peekSession,
  hasSession,
  deleteSession,
  sessionCount,
  sweepExpiredSessions,
  SESSION_TTL_MS,
};
