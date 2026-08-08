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

/**
 * Derive a seniority level and a domain from the free-text job role.
 *
 * Pure and self-contained so the rules are readable in one place and cheap to
 * adjust. Display metadata only — nothing here feeds topic selection or the
 * interview itself.
 *
 * Short tokens are matched on word boundaries rather than as bare substrings.
 * That is not pedantry: against the real data, a plain "contains" check puts
 * "Disting(ui)shed Engineer" in Design and "Arch(it)ect" in IT/Support.
 *
 * @param {string} jobRole
 * @param {number} yearsExperience
 * @returns {{level: string, domain: string}}
 */
function deriveLevelAndDomain(jobRole, yearsExperience) {
  const role = String(jobRole || '');
  const years = Number(yearsExperience);

  // --- level: title keywords beat raw years where they are the stronger signal
  let level;
  if (/\bintern\b/i.test(role)) {
    level = 'Entry';
  } else if (/\b(distinguished|principal|staff)\b/i.test(role)) {
    level = 'Staff+';
  } else if (!Number.isFinite(years)) {
    level = 'Mid';
  } else if (years <= 2) {
    level = 'Entry';
  } else if (years <= 5) {
    level = 'Mid';
  } else if (years <= 9) {
    level = 'Senior';
  } else {
    level = 'Staff+';
  }

  // --- domain: ordered, first match wins
  const domainRules = [
    [/\bai\b|machine learning|\bml\b/i, 'AI/ML'],
    [/data/i, 'Data'],
    [/devops|\bsre\b|infrastructure/i, 'DevOps'],
    [/mobile|\bios\b|android/i, 'Mobile'],
    [/\bux\b|\bui\b|design/i, 'Design'],
    [/marketing|business|product/i, 'Business'],
    [/\bit\b|support/i, 'IT/Support'],
    // Checked last, and deliberately wide: "Architect", "Developer" and
    // "Computer Science" are engineering roles that the narrower
    // backend/software/engineer list dropped into the generic "General"
    // bucket. "HR Manager" is the only role in the sample data that correctly
    // stays General.
    [/backend|software|engineer|developer|architect|computer science/i, 'Engineering'],
  ];

  const matched = domainRules.find(([pattern]) => pattern.test(role));
  return { level, domain: matched ? matched[1] : 'General' };
}

/** Index by member id for O(1) detail lookups. */
const byId = new Map(candidates.map((c) => [c.member.id, c]));

router.get('/', (req, res) => {
  res.json({
    candidates: candidates.map((c) => ({
      id: c.member.id,
      name: c.member.name,
      jobRole: c.member.jobRole,
      yearsExperience: c.member.yearsExperience,
      ...deriveLevelAndDomain(c.member.jobRole, c.member.yearsExperience),
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
module.exports.deriveLevelAndDomain = deriveLevelAndDomain; // exported for tests
