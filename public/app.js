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
        role.textContent = c.jobRole;

        const go = document.createElement('span');
        go.className = 'cand__go';
        go.textContent = 'Start interview →';

        card.append(id, name, role, go);
        card.addEventListener('click', () => beginInterview(c, card));
        el.grid.appendChild(card);
      }
    } catch (err) {
      el.grid.setAttribute('aria-busy', 'false');
      el.grid.textContent = `Could not load candidates: ${err.message}`;
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
    bubble('candidate', text);
    showThinking();

    try {
      const res = await api('/api/interview', {
        method: 'POST',
        body: JSON.stringify({ sessionId: state.sessionId, message: text }),
      });
      hideThinking();

      if (res.done) {
        await refreshMeta();
        renderReport(res.feedback);
        return;
      }

      bubble('interviewer', res.reply);
      await refreshMeta();
      setBusy(false);
    } catch (err) {
      hideThinking();
      bubble('error', `${err.message} — your answer was not recorded. Try sending it again.`);
      setBusy(false);
    }
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

      const step = document.createElement('li');
      step.className = `step${done ? ' step--done' : ''}${current ? ' step--current' : ''}`;

      const tile = document.createElement('span');
      tile.className = 'step__tile';
      tile.textContent = done ? '✓' : String(topic.day);
      tile.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'step__label';

      const title = document.createElement('span');
      title.className = 'step__title';
      title.textContent = topic.title;

      const why = document.createElement('span');
      why.className = 'step__why';
      why.textContent = whyCaption(topic);

      label.append(title, why);
      step.append(tile, label);

      // The full scoring rationale from the server, on hover.
      step.title = `Day ${topic.day} — ${topic.title}\n${topic.reason}`;
      step.setAttribute(
        'aria-label',
        `${done ? 'Completed' : current ? 'In progress' : 'Upcoming'}: day ${topic.day}, ${topic.title}. ${topic.reason}`,
      );

      el.rail.appendChild(step);
    });

    el.railProgress.textContent = `${Math.min(meta.questionCount, meta.totalQuestions)}/${meta.totalQuestions} Q`;

    const active = meta.plan[Math.min(meta.currentIndex, meta.plan.length - 1)];
    if (active) {
      el.candDay.textContent = `DAY ${active.day}`;
      el.candTopic.textContent = active.title;
    }
  }

  // ---------------------------------------------------------------- report

  function statCard({ label, value, tag, tone }) {
    const card = document.createElement('div');
    card.className = `stat stat--${tone}`;
    card.setAttribute('role', 'listitem');

    const l = document.createElement('span');
    l.className = 'stat__label';
    l.textContent = label;

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
      }),
      statCard({
        label: 'Days covered',
        value: meta?.plan?.length ?? '—',
        tag: 'Personalised',
        tone: 'accent',
      }),
      statCard({
        label: 'Strengths',
        value: strengths.length,
        tag: 'Positive',
        tone: 'green',
      }),
      statCard({
        label: 'Gaps',
        value: gaps.length,
        tag: 'To address',
        tone: 'coral',
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
