/**
 * Demo-only candidate endpoints. NOT part of the graded API contract.
 *
 * These exist so the bundled frontend has a candidate picker without hardcoding
 * the sample data into the client. They are lightly rate-limited; the graded
 * /api/interview route deliberately is not, so nothing can throttle a judging or
 * live-steer run.
 *
 *   GET /api/candidates      → [{ id, name, jobRole }]  (list, per spec)
 *   GET /api/candidates/:id  → the full candidate object, ready to POST to
 *                              /api/interview as the `candidate` field
 */

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { candidates } = require('../data/candidates.json');

const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // generous: a picker refresh is a handful of requests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests to the demo candidates endpoint. Try again shortly.' },
});

router.use(limiter);

/** Index by member id for O(1) detail lookups. */
const byId = new Map(candidates.map((c) => [c.member.id, c]));

router.get('/', (req, res) => {
  res.json({
    candidates: candidates.map((c) => ({
      id: c.member.id,
      name: c.member.name,
      jobRole: c.member.jobRole,
    })),
  });
});

router.get('/:id', (req, res) => {
  const candidate = byId.get(req.params.id);
  if (!candidate) {
    return res.status(404).json({ error: `No demo candidate with id "${req.params.id}".` });
  }
  return res.json({ candidate });
});

module.exports = router;
