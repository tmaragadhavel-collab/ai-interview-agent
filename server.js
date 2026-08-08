/**
 * AI Interview Agent — Express entrypoint.
 *
 * One long-running process. The interview is a multi-request state machine keyed
 * by sessionId, so the process must survive between HTTP calls; that is why this
 * is a persistent web service rather than a set of serverless functions (see
 * README, "Why Express + Render").
 */

require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const interviewRoutes = require('./src/routes/interview');
const candidateRoutes = require('./src/routes/candidates');
const metaRoutes = require('./src/routes/meta');
const { sessionCount, SESSION_TTL_MS } = require('./src/engine/sessionStore');
const { MODEL } = require('./src/engine/claude');

// ------------------------------------------------- fail fast on bad config

// Every question and the final feedback depend on this key. Discovering it is
// missing on the first candidate's first turn — after a judge has already
// started — is far worse than refusing to boot.
if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_API_KEY.trim()) {
  console.error(
    '\n[fatal] ANTHROPIC_API_KEY is not set.\n' +
      '        Local:  copy .env.example to .env and add your key.\n' +
      '        Render: add it under Environment > Environment Variables.\n',
  );
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS at its proxy; without this, client IPs (and therefore
// the demo rate limiter) see the proxy rather than the caller.
app.set('trust proxy', 1);

// ------------------------------------------------------------- middleware

// Helmet's default CSP is `default-src 'self'`, which would block the Google
// Fonts stylesheet and font files the UI loads. Widened for exactly those two
// hosts and nothing else.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Covers both <style> blocks and the inline style attributes used for
        // dynamic progress-rail sizing (style-src-attr falls back to this).
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // The API is intended to be called cross-origin by graders.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

// Open CORS: the graded endpoint takes no credentials and holds no user data,
// and a judge may call it from any origin or tool.
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

app.use(express.json({ limit: '256kb' }));

// Malformed JSON otherwise surfaces as a 500. The contract promises clean 4xx
// for bad input, so translate it here.
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }
  return next(err);
});

// One line per API request, so a judge reading the logs can follow a session.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(
      `[http] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`,
    );
  });
  return next();
});

// ----------------------------------------------------------------- routes

// Graded contract.
app.use('/api/interview', interviewRoutes);
// Demo-only. Mounted on the same prefix but only claims /:sessionId/meta, so it
// cannot shadow POST /api/interview.
app.use('/api/interview', metaRoutes);
app.use('/api/candidates', candidateRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: MODEL,
    activeSessions: sessionCount(),
    sessionTtlMinutes: SESSION_TTL_MS / 60000,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Static glassmorphism frontend, served by this same process.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// JSON 404 for unknown API paths (rather than falling through to the SPA).
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
});

// ---------------------------------------------------------- error handler

app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} — ${err.stack || err.message}`);
  } else {
    console.log(`[error] ${req.method} ${req.originalUrl} ${status} — ${err.message}`);
  }
  res.status(status).json({
    error: status >= 500 ? 'Internal server error.' : err.message,
  });
});

const server = app.listen(PORT, () => {
  console.log(`[boot] AI Interview Agent listening on :${PORT}`);
  console.log(`[boot] model=${MODEL} session_ttl_min=${SESSION_TTL_MS / 60000}`);
  console.log(`[boot] POST /api/interview  |  GET /health  |  UI at /`);
});

// Render sends SIGTERM on deploy/scale-down; close cleanly so in-flight
// requests finish instead of being cut off.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal} received, closing server`);
    server.close(() => process.exit(0));
  });
}

module.exports = app;
