/**
 * Interview Plan Builder — deterministic topic selection.
 *
 * The server, not the model, decides what gets asked and when. Claude writes the
 * words; this file decides the syllabus. That split is what makes the
 * "8+ questions across 4+ distinct curriculum days" requirement a property of the
 * code rather than something we hope the model counts correctly.
 *
 * Selection: 5 curriculum days drawn from the candidate's own mission record,
 * weighted so struggle signals dominate but a rapport/baseline check is always
 * reserved.
 *
 *   skipped: true      → 100  (no hands-on exposure at all — biggest unknown)
 *   passed: false      →  90  (tried, didn't clear it)
 *   attempts >= 5      →  70  (cleared, but ground it out)
 *   attempts >= 3      →  50  (moderate friction)
 *   attempts === 2     →  30  (minor friction)
 *   passed first try   →  10  (baseline — confirm real understanding, not familiarity)
 *
 * Note the ordering of the checks: a skipped mission carries NO `passed` and NO
 * `attempts` key in candidates.json, so `passed === false` would read `undefined`
 * and fall through. `skipped` must be tested first.
 */

const curriculum = require('../data/curriculum.json');

/** day number → curriculum day object */
const curriculumByDay = new Map(curriculum.days.map((day) => [day.day, day]));

const TOPIC_COUNT = 5; // 5 topics x 2 questions = 10 questions across 5 days
const STRUGGLE_SLOTS = 3; // filled first, highest score wins
const BASELINE_SLOTS = 2; // reserved for clean first-try passes

/** Ranking used when padding a plan for a candidate with sparse mission data. */
const TYPE_PRIORITY = {
  AI_CORE: 0,
  BUILD: 1,
  SHIP_IT: 2,
  OPTIMIZE: 3,
  LEARN: 4,
  CAPSTONE: 5,
  SETUP: 6,
};

function scoreMission(mission) {
  if (mission.skipped) return 100;
  if (mission.passed === false) return 90;
  const attempts = mission.attempts ?? 1;
  if (attempts >= 5) return 70;
  if (attempts >= 3) return 50;
  if (attempts === 2) return 30;
  return 10;
}

/** Human-readable justification for why a topic made the plan. Surfaced in logs and /meta. */
function describeReason(mission, score) {
  if (mission.skipped) return 'skipped the mission — probe for baseline understanding';
  if (mission.passed === false) {
    return `failed after ${mission.attempts ?? 'multiple'} attempt(s) — deep dive`;
  }
  if (score === 70) return `passed, but took ${mission.attempts} attempts — significant struggle`;
  if (score === 50) return `passed after ${mission.attempts} attempts — moderate struggle`;
  if (score === 30) return 'passed on the 2nd attempt — minor friction';
  return 'passed first try — baseline / rapport check';
}

/**
 * Build one plan entry, joining the candidate's record for a day to that day's
 * curriculum detail (title, type, tools, objectives).
 */
function buildTopicEntry(mission, score) {
  const day = curriculumByDay.get(mission.day);
  return {
    day: mission.day,
    // Fall back to the title on the mission itself if a candidate references a
    // day outside the 31-day curriculum.
    title: day?.title || mission.title || `Day ${mission.day}`,
    type: day?.type || 'UNKNOWN',
    tools: day?.tools || [],
    objectives: day?.objectives || [],
    missionData: {
      passed: mission.passed ?? null,
      skipped: mission.skipped === true,
      attempts: mission.attempts ?? null,
    },
    score,
    reason: describeReason(mission, score),
  };
}

/** A curriculum day the candidate has no record for — asked as a general probe. */
function buildProbeEntry(day) {
  return {
    day: day.day,
    title: day.title,
    type: day.type,
    tools: day.tools,
    objectives: day.objectives,
    missionData: null,
    score: 0,
    reason: 'no record for this day — general-knowledge probe',
  };
}

/**
 * @param {Object} candidate — { member, missions, signals }
 * @returns {Array<Object>} exactly TOPIC_COUNT plan entries (fewer only if the
 *   curriculum itself were smaller than 5 days, which it is not)
 */
function buildPlan(candidate) {
  const missions = Array.isArray(candidate.missions) ? candidate.missions : [];

  // Deduplicate by day before scoring — a malformed candidate could repeat one.
  const seenDays = new Set();
  const scored = [];
  for (const mission of missions) {
    if (typeof mission?.day !== 'number' || seenDays.has(mission.day)) continue;
    seenDays.add(mission.day);
    scored.push({ mission, score: scoreMission(mission) });
  }

  // Sort by struggle descending; `day` ascending breaks ties so the plan for a
  // given candidate is byte-identical on every run.
  scored.sort((a, b) => b.score - a.score || a.mission.day - b.mission.day);

  const struggle = scored.filter((s) => s.score >= 30);
  const baseline = scored.filter((s) => s.score < 30);

  const chosen = [];
  const take = (pool, limit) => {
    for (const entry of pool) {
      if (chosen.length >= limit) break;
      if (chosen.some((c) => c.day === entry.mission.day)) continue;
      chosen.push(buildTopicEntry(entry.mission, entry.score));
    }
  };

  // 1. Struggle topics first — they carry the most signal.
  take(struggle, STRUGGLE_SLOTS);
  // 2. Reserve slots for clean passes, so the interview always contains a
  //    "confirm real understanding" check and doesn't read as an interrogation.
  take(baseline, STRUGGLE_SLOTS + BASELINE_SLOTS);
  // 3. Either bucket may have been empty (real candidates in the data hit both
  //    extremes) — backfill from whatever is left.
  take(struggle, TOPIC_COUNT);
  take(baseline, TOPIC_COUNT);

  // 4. Still short: candidate has fewer than 5 days on record. Pad with
  //    curriculum days they have no data for, favouring AI-core content.
  if (chosen.length < TOPIC_COUNT) {
    const chosenDays = new Set(chosen.map((t) => t.day));
    const probes = curriculum.days
      .filter((d) => !seenDays.has(d.day) && !chosenDays.has(d.day))
      .sort(
        (a, b) =>
          (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99) || a.day - b.day,
      );
    for (const day of probes) {
      if (chosen.length >= TOPIC_COUNT) break;
      chosen.push(buildProbeEntry(day));
    }
  }

  // Sequence the interview: open on the lowest-pressure topic and ramp up, the
  // way a real interviewer warms a candidate before the hard questions. Ties
  // resolve chronologically, so equally-weighted topics follow the cohort order.
  chosen.sort((a, b) => a.score - b.score || a.day - b.day);

  return chosen;
}

module.exports = { buildPlan, curriculumByDay, scoreMission, TOPIC_COUNT };
