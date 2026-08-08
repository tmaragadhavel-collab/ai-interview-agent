/**
 * Demo-only session introspection. NOT part of the graded API contract.
 *
 *   GET /api/interview/:sessionId/meta
 *
 * The frontend's progress rail needs to know which curriculum days are in the
 * plan and which one is in progress. That information is real personalisation
 * data, but putting it on the POST /api/interview response would change a
 * response shape that technical-spec.md pins exactly — so it lives here instead,
 * read from the same session state.
 *
 * Read-only: uses peekSession so polling this route can never keep a dead
 * session alive past its TTL.
 */

const { Router } = require('express');
const { peekSession } = require('../engine/sessionStore');

const router = Router();

router.get('/:sessionId/meta', (req, res) => {
  const session = peekSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: `Session "${req.params.sessionId}" not found or expired.` });
  }

  const done = session.phase === 'done';

  return res.json({
    sessionId: req.params.sessionId,
    candidate: {
      name: session.member.name,
      jobRole: session.member.jobRole,
      yearsExperience: session.member.yearsExperience,
    },
    // The plan, minus nothing — this is the personalisation story, so show it.
    plan: session.plan.map((topic) => ({
      day: topic.day,
      title: topic.title,
      type: topic.type,
      reason: topic.reason,
      score: topic.score,
      missionData: topic.missionData,
      // Live grade for this topic's first answer, once it has been given.
      // Null until then, so the UI knows to keep showing the pre-interview
      // reasoning caption instead.
      verdict: topic.verdict || null,
    })),
    // Once finished, currentIndex sits past the end so every orb reads complete.
    currentIndex: done ? session.plan.length : session.topicIndex,
    questionCount: session.questionCount,
    totalQuestions: session.plan.length * 2,
    phase: session.phase,
    done,
  });
});

module.exports = router;
