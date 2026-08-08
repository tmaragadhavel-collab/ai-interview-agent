/* ============================================================================
   AI Interview Agent — client

   Plain JS, no framework: three screens, one fetch helper, no build step.

   The client is deliberately thin. It never decides how many questions to ask,
   which topic comes next, or when the interview ends — the server owns all of
   that. Here we render `reply`, watch `done`, and read the plan from the
   demo-only /meta endpoint to drive the progress rail.
   ========================================================================= */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ icons
  //
  // Lucide (MIT) geometry, inlined as SVG rather than pulled from a CDN: one
  // icon set, no extra request, no CSP allowance for a third-party origin, and
  // no dependency. All are 24x24 line icons drawn with currentColor, so they
  // tint from whatever accent the surrounding element uses.

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ICONS = {
    database: [
      ['ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }],
      ['path', { d: 'M3 5v14a9 3 0 0 0 18 0V5' }],
      ['path', { d: 'M3 12a9 3 0 0 0 18 0' }],
    ],
    'message-square': [
      ['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }],
    ],
    bot: [
      ['path', { d: 'M12 8V4H8' }],
      ['rect', { x: 4, y: 8, width: 16, height: 12, rx: 2 }],
      ['path', { d: 'M2 14h2' }],
      ['path', { d: 'M20 14h2' }],
      ['path', { d: 'M15 13v2' }],
      ['path', { d: 'M9 13v2' }],
    ],
    plug: [
      ['path', { d: 'M12 22v-5' }],
      ['path', { d: 'M9 8V2' }],
      ['path', { d: 'M15 8V2' }],
      ['path', { d: 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z' }],
    ],
    cloud: [['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }]],
    activity: [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
    network: [
      ['rect', { x: 16, y: 16, width: 6, height: 6, rx: 1 }],
      ['rect', { x: 2, y: 16, width: 6, height: 6, rx: 1 }],
      ['rect', { x: 9, y: 2, width: 6, height: 6, rx: 1 }],
      ['path', { d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' }],
      ['path', { d: 'M12 12V8' }],
    ],
    'list-checks': [
      ['path', { d: 'm3 17 2 2 4-4' }],
      ['path', { d: 'm3 7 2 2 4-4' }],
      ['path', { d: 'M13 6h8' }],
      ['path', { d: 'M13 12h8' }],
      ['path', { d: 'M13 18h8' }],
    ],
    calendar: [
      ['path', { d: 'M8 2v4' }],
      ['path', { d: 'M16 2v4' }],
      ['rect', { x: 3, y: 4, width: 18, height: 18, rx: 2 }],
      ['path', { d: 'M3 10h18' }],
    ],
    'trending-up': [
      ['polyline', { points: '22 7 13.5 15.5 8.5 10.5 2 17' }],
      ['polyline', { points: '16 7 22 7 22 13' }],
    ],
    flag: [
      ['path', { d: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z' }],
      ['line', { x1: 4, y1: 22, x2: 4, y2: 15 }],
    ],
    'check-circle': [
      ['path', { d: 'M21.8 10A10 10 0 1 1 17 3.3' }],
      ['path', { d: 'm9 11 3 3L22 4' }],
    ],
    'circle-dashed': [
      ['circle', { cx: 12, cy: 12, r: 9, 'stroke-dasharray': '3 3.2' }],
    ],
    'alert-circle': [
      ['circle', { cx: 12, cy: 12, r: 10 }],
      ['line', { x1: 12, y1: 8, x2: 12, y2: 12 }],
      ['line', { x1: 12, y1: 16, x2: 12.01, y2: 16 }],
    ],
    'alert-triangle': [
      ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
      ['path', { d: 'M12 9v4' }],
      ['path', { d: 'M12 17h.01' }],
    ],
    briefcase: [
      ['path', { d: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }],
      ['rect', { x: 2, y: 6, width: 20, height: 14, rx: 2 }],
    ],
  };

  /** Build an inline SVG icon. Decorative by default — hidden from a11y. */
  function icon(name, className = '') {
    const shapes = ICONS[name] || ICONS.network;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', `icon ${className}`.trim());
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      svg.appendChild(node);
    }
    return svg;
  }

  /**
   * Curriculum topic → icon. Matched on the day's title first (which is what
   * actually describes the subject), falling back to the day's type.
   */
  function topicIcon(topic) {
    const t = `${topic.title || ''}`.toLowerCase();
    if (/vector|embedding|retriev|rag|index|database/.test(t)) return 'database';
    if (/prompt/.test(t)) return 'message-square';
    if (/agent|orchestr/.test(t)) return 'bot';
    if (/mcp|model context protocol/.test(t)) return 'plug';
    if (/monitor|logging|observab/.test(t)) return 'activity';
    if (/docker|kubernet|deploy|ship|production|cloud/.test(t)) return 'cloud';
    return { AI_CORE: 'database', LEARN: 'message-square', SHIP_IT: 'cloud', OPTIMIZE: 'activity' }[topic.type] || 'network';
  }

  /** Three-tier grade presentation, shared by the rail and the transcript. */
  const VERDICT = {
    strong: { icon: 'check-circle', rail: 'Strong answer', short: 'Strong' },
    partial: { icon: 'circle-dashed', rail: 'Partially there', short: 'Partial' },
    weak: { icon: 'alert-circle', rail: 'Needed a correction', short: 'Weak' },
  };

  const el = {
    screens: {
      picker: $('screen-picker'),
      interview: $('screen-interview'),
      feedback: $('screen-feedback'),
    },
    grid: $('candidate-grid'),
    rail: $('rail-track'),
    railProgress: $('rail-progress'),
    avatar: $('cand-avatar'),
    candGreet: $('cand-greet'),
    candRole: $('cand-role'),
    candDay: $('cand-day'),
    candTopic: $('cand-topic'),
    transcript: $('transcript'),
    composer: $('composer'),
    answer: $('answer'),
    send: $('send'),
    reportStats: $('report-stats'),
    reportSummary: $('report-summary'),
    reportMeta: $('report-meta'),
    lists: {
      strengths: $('list-strengths'),
      gaps: $('list-gaps'),
      next: $('list-next'),
    },
    restart: $('restart'),
  };

  const state = {
    sessionId: null,
    meta: null,
    busy: false,
  };

  // ------------------------------------------------------------- utilities

  function showScreen(name) {
    for (const [key, node] of Object.entries(el.screens)) {
      node.hidden = key !== name;
    }
    window.scrollTo({ top: 0 });
  }

  /**
   * JSON fetch that surfaces the server's own `error` string.
   * Every 4xx from this API carries one, so the UI can say what went wrong
   * instead of "something failed".
   */
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* fall through to the generic message below */
    }
    if (!res.ok) {
      throw new Error(body?.error || `Request failed (HTTP ${res.status}).`);
    }
    return body;
  }

  /** First letters of the first and last name, for the avatar circle. */
  function initials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0][0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
    return (first + last).toUpperCase();
  }

  /** Text is always inserted as textContent — never innerHTML. */
  function bubble(role, text) {
    const node = document.createElement('div');
    node.className = `bubble bubble--${role}`;

    if (role !== 'error') {
      const who = document.createElement('span');
      who.className = 'bubble__who';
      who.textContent = role === 'interviewer' ? 'Interviewer' : 'You';
      node.appendChild(who);
    }

    const body = document.createElement('span');
    body.textContent = text;
    node.appendChild(body);

    el.transcript.appendChild(node);
    scrollTranscript();
    return node;
  }

  function scrollTranscript() {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.transcript.scrollTo({
      top: el.transcript.scrollHeight,
      behavior: reduce ? 'auto' : 'smooth',
    });
  }

  function showThinking() {
    const pill = document.createElement('div');
    pill.className = 'thinking';
    pill.id = 'thinking';
    pill.setAttribute('aria-label', 'Interviewer is thinking');
    for (let i = 0; i < 3; i += 1) pill.appendChild(document.createElement('span'));
    el.transcript.appendChild(pill);
    scrollTranscript();
  }

  function hideThinking() {
    $('thinking')?.remove();
  }

  function setBusy(busy) {
    state.busy = busy;
    el.send.disabled = busy;
    el.answer.disabled = busy;
    if (!busy) el.answer.focus();
  }

  // --------------------------------------------------------------- picker

  async function loadCandidates() {
    try {
      const { candidates } = await api('/api/candidates');
      el.grid.textContent = '';
      el.grid.setAttribute('aria-busy', 'false');

      for (const c of candidates) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'cand';
        card.setAttribute('role', 'listitem');
        card.setAttribute('aria-label', `Interview ${c.name}, ${c.jobRole}`);

        const id = document.createElement('span');
        id.className = 'cand__id';
        id.textContent = c.id;

        const name = document.createElement('span');
        name.className = 'cand__name';
        name.textContent = c.name;

        const role = document.createElement('span');
        role.className = 'cand__role';
        role.append(icon('briefcase', 'icon--role'), document.createTextNode(c.jobRole));

        const go = document.createElement('span');
        go.className = 'cand__go';
        go.textContent = 'Start interview →';

        card.append(id, name, role, go);
        card.addEventListener('click', () => beginInterview(c, card));
        el.grid.appendChild(card);
      }
    } catch (err) {
      el.grid.setAttribute('aria-busy', 'false');
      el.grid.textContent = '';

      const glyph = icon(err instanceof TypeError ? 'alert-triangle' : 'alert-circle', 'icon--empty');

      const msg = document.createElement('p');
      msg.className = 'grid__status';
      // A bare fetch rejection (TypeError) means the request never reached a
      // server — almost always the Node process not running, which the generic
      // "Failed to fetch" does nothing to explain.
      msg.textContent =
        err instanceof TypeError
          ? `Could not reach the server at ${location.origin}. Check that "npm start" is running, then retry.`
          : `Could not load candidates: ${err.message}`;

      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn--ghost grid__retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        el.grid.textContent = '';
        el.grid.setAttribute('aria-busy', 'true');
        loadCandidates();
      });

      el.grid.append(glyph, msg, retry);
    }
  }

  // ------------------------------------------------------------ interview

  async function beginInterview(summary, card) {
    // Disable the whole grid while starting, so a double-click can't open two
    // sessions.
    el.grid.querySelectorAll('.cand').forEach((c) => {
      c.disabled = true;
    });
    card.querySelector('.cand__go').textContent = 'Starting…';

    try {
      const { candidate } = await api(`/api/candidates/${encodeURIComponent(summary.id)}`);

      // sessionId is minted client-side, per the spec.
      state.sessionId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const started = await api('/api/interview', {
        method: 'POST',
        body: JSON.stringify({ sessionId: state.sessionId, candidate }),
      });

      const member = candidate.member;
      el.avatar.textContent = initials(member.name);
      el.candGreet.textContent = `Let's begin, ${member.name.split(/\s+/)[0]} 👋`;
      el.candRole.textContent = `${member.jobRole} · ${member.yearsExperience} yrs experience`;
      el.transcript.textContent = '';

      showScreen('interview');
      bubble('interviewer', started.reply);
      await refreshMeta();
      setBusy(false);
    } catch (err) {
      el.grid.querySelectorAll('.cand').forEach((c) => {
        c.disabled = false;
      });
      card.querySelector('.cand__go').textContent = 'Start interview →';
      alert(`Could not start the interview.\n\n${err.message}`);
    }
  }

  async function sendAnswer(text) {
    setBusy(true);
    const myBubble = bubble('candidate', text);
    showThinking();

    // The graded response body deliberately carries only { reply, done }, so
    // the verdict is picked up from the demo /meta endpoint instead: snapshot
    // the verdicts before the turn, and whichever topic gains one belongs to
    // the answer just sent.
    const before = (state.meta?.plan || []).map((t) => t.verdict || null);

    try {
      const res = await api('/api/interview', {
        method: 'POST',
        body: JSON.stringify({ sessionId: state.sessionId, message: text }),
      });
      hideThinking();

      if (res.done) {
        await refreshMeta();
        markGraded(myBubble, before);
        renderReport(res.feedback);
        return;
      }

      bubble('interviewer', res.reply);
      await refreshMeta();
      markGraded(myBubble, before);
      setBusy(false);
    } catch (err) {
      hideThinking();
      bubble('error', `${err.message} — your answer was not recorded. Try sending it again.`);
      setBusy(false);
    }
  }

  /**
   * Attach a grade badge to the answer bubble that was just assessed.
   * `before` is the verdict snapshot taken prior to the turn; the first topic
   * to gain a verdict is the one this answer belongs to.
   */
  function markGraded(bubbleNode, before) {
    if (!bubbleNode || !state.meta) return;
    const after = state.meta.plan.map((t) => t.verdict || null);
    const idx = after.findIndex((v, i) => v && !before[i]);
    if (idx === -1) return;

    const spec = VERDICT[after[idx]];
    if (!spec) return;

    const badge = document.createElement('span');
    badge.className = `grade grade--${after[idx]}`;
    badge.append(icon(spec.icon, 'icon--grade'), document.createTextNode(spec.short));
    badge.setAttribute('aria-label', `Assessment of this answer: ${spec.rail}`);
    bubbleNode.appendChild(badge);
  }

  // ----------------------------------------------------------- progress rail

  /**
   * Pull the plan and current position from the demo-only meta endpoint. This is
   * real personalisation data — actual curriculum day numbers chosen from this
   * candidate's record — not decoration.
   */
  async function refreshMeta() {
    try {
      state.meta = await api(`/api/interview/${encodeURIComponent(state.sessionId)}/meta`);
    } catch {
      return; // rail is a nicety; never let it break the interview
    }
    renderRail();
  }

  /**
   * Short "why this day" caption for a rail tile, derived from the same
   * mission record that drove topic selection server-side. Without this, a plan
   * that jumps 7 → 8 → 12 → 28 → 29 looks arbitrary; with it, the ordering
   * reads as deliberate.
   */
  function whyCaption(topic) {
    const md = topic.missionData;
    if (!md) return 'No record — general probe';
    if (md.skipped) return 'Skipped';
    if (md.passed === false) {
      return md.attempts ? `Failed, ${md.attempts} attempts` : 'Failed';
    }
    const attempts = md.attempts ?? 1;
    if (attempts === 1) return 'Passed 1st try — baseline';
    return `${attempts} attempts`;
  }

  function renderRail() {
    const meta = state.meta;
    if (!meta) return;

    el.rail.textContent = '';

    meta.plan.forEach((topic, i) => {
      const done = i < meta.currentIndex;
      const current = i === meta.currentIndex;

      // Once a topic is finished and graded, the caption switches from the
      // pre-interview reasoning to what actually happened in the interview.
      const graded = done && topic.verdict ? VERDICT[topic.verdict] : null;

      const step = document.createElement('li');
      step.className =
        `step${done ? ' step--done' : ''}${current ? ' step--current' : ''}` +
        (graded ? ` step--${topic.verdict}` : '');

      const tile = document.createElement('span');
      tile.className = 'step__tile';
      tile.textContent = done ? '✓' : String(topic.day);
      tile.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'step__label';

      const title = document.createElement('span');
      title.className = 'step__title';
      title.append(icon(topicIcon(topic), 'icon--topic'), document.createTextNode(topic.title));

      const why = document.createElement('span');
      why.className = 'step__why';
      if (graded) {
        why.append(icon(graded.icon, 'icon--verdict'), document.createTextNode(graded.rail));
      } else {
        why.textContent = whyCaption(topic);
      }

      label.append(title, why);
      step.append(tile, label);

      // No `title` attribute: a native tooltip renders as an overlay that can
      // cover the transcript, and the .step__why caption below already shows
      // this information permanently. The full rationale stays on aria-label
      // for screen readers.
      step.setAttribute(
        'aria-label',
        `${done ? 'Completed' : current ? 'In progress' : 'Upcoming'}: day ${topic.day}, ` +
          `${topic.title}. ${graded ? `Assessment: ${graded.rail}.` : topic.reason}`,
      );

      el.rail.appendChild(step);
    });

    el.railProgress.textContent = `${Math.min(meta.questionCount, meta.totalQuestions)}/${meta.totalQuestions} Q`;

    const active = meta.plan[Math.min(meta.currentIndex, meta.plan.length - 1)];
    if (active) {
      el.candDay.textContent = `DAY ${active.day}`;
      el.candTopic.textContent = '';
      el.candTopic.append(
        icon(topicIcon(active), 'icon--topic'),
        document.createTextNode(active.title),
      );
    }
  }

  // ---------------------------------------------------------------- report

  function statCard({ label, value, tag, tone, iconName }) {
    const card = document.createElement('div');
    card.className = `stat stat--${tone}`;
    card.setAttribute('role', 'listitem');

    const l = document.createElement('span');
    l.className = 'stat__label';
    l.append(icon(iconName, 'icon--stat'), document.createTextNode(label));

    const v = document.createElement('span');
    v.className = 'stat__value';
    v.textContent = String(value);

    card.append(l, v);

    if (tag) {
      const t = document.createElement('span');
      t.className = 'stat__tag';
      t.textContent = tag;
      card.appendChild(t);
    }
    return card;
  }

  function renderReport(feedback) {
    const safe = feedback && typeof feedback === 'object' ? feedback : {};
    const meta = state.meta;

    const strengths = Array.isArray(safe.strengths) ? safe.strengths : [];
    const gaps = Array.isArray(safe.gaps) ? safe.gaps : [];
    const next = Array.isArray(safe.next) ? safe.next : [];

    // Stat row — only numbers the server actually guarantees.
    el.reportStats.textContent = '';
    el.reportStats.append(
      statCard({
        label: 'Questions asked',
        value: meta?.questionCount ?? '—',
        tag: 'Complete',
        tone: 'accent',
        iconName: 'list-checks',
      }),
      statCard({
        label: 'Days covered',
        value: meta?.plan?.length ?? '—',
        tag: 'Personalised',
        tone: 'accent',
        iconName: 'calendar',
      }),
      statCard({
        label: 'Strengths',
        value: strengths.length,
        tag: 'Positive',
        tone: 'green',
        iconName: 'trending-up',
      }),
      statCard({
        label: 'Gaps',
        value: gaps.length,
        tag: 'To address',
        tone: 'coral',
        iconName: 'flag',
      }),
    );

    el.reportSummary.textContent =
      safe.summary || 'No summary was returned for this interview.';

    el.reportMeta.textContent = meta
      ? `${meta.candidate.name} · ${meta.plan.map((t) => `Day ${t.day}`).join(', ')}`
      : '';

    for (const [key, items] of Object.entries({ strengths, gaps, next })) {
      const list = el.lists[key];
      list.textContent = '';
      if (!items.length) {
        const li = document.createElement('li');
        li.textContent = 'None recorded.';
        list.appendChild(li);
        continue;
      }
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = String(item);
        list.appendChild(li);
      }
    }

    showScreen('feedback');
    el.restart.focus();
  }

  // ------------------------------------------------------------- listeners

  el.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.answer.value.trim();
    if (!text || state.busy) return;
    el.answer.value = '';
    autosize();
    sendAnswer(text);
  });

  // Enter sends, Shift+Enter inserts a newline.
  el.answer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      el.composer.requestSubmit();
    }
  });

  function autosize() {
    el.answer.style.height = 'auto';
    el.answer.style.height = `${Math.min(el.answer.scrollHeight, 136)}px`;
  }
  el.answer.addEventListener('input', autosize);

  el.restart.addEventListener('click', () => {
    state.sessionId = null;
    state.meta = null;
    el.transcript.textContent = '';
    el.rail.textContent = '';
    el.grid.querySelectorAll('.cand').forEach((c) => {
      c.disabled = false;
      c.querySelector('.cand__go').textContent = 'Start interview →';
    });
    showScreen('picker');
  });

  // Warn before losing an interview in progress.
  window.addEventListener('beforeunload', (event) => {
    if (state.sessionId && el.screens.interview.hidden === false) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  loadCandidates();
})();
