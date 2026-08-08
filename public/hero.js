/* ============================================================================
   Hero depth-parallax node network — picker screen only.

   The 3D read comes from parallax across depth layers, not from shading: each
   node carries a simulated depth z (0 = far, 1 = near), and on pointer move
   every node shifts by an amount proportional to its own z. Near nodes travel
   noticeably further than far ones, which is the same cue "3D photo" effects
   use. Per-node sphere shading and blur reinforce it, but the motion is what
   sells it.

   Themed as a loose constellation — curriculum topics as a connected network —
   rather than generic decoration.

   Deliberately a separate script from app.js: this is ornament, and a failure
   here must not be able to take down the candidate fetch. Nothing outside this
   IIFE depends on it.

   No dependencies. Canvas 2D only.
   ========================================================================= */

(() => {
  'use strict';

  const canvas = document.getElementById('hero-net');
  if (!canvas || !canvas.getContext) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const host = canvas.parentElement; // .picker__head — receives the pointer
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const ACCENT = [255, 122, 26];
  const PLAIN = [255, 255, 255];

  let W = 0;
  let H = 0;
  let nodes = [];
  let rafId = null;
  let visible = true;

  // Pointer parallax: `target` is where the cursor wants to push things,
  // `cur` eases toward it so leaving the area drifts back instead of snapping.
  const par = { targetX: 0, targetY: 0, curX: 0, curY: 0 };
  const MAX_SHIFT = 26; // px, at z = 1

  const rand = (min, max) => min + Math.random() * (max - min);

  function nodeCount() {
    // Fewer nodes on narrow screens: less clutter behind the headline, and
    // less to draw on a weaker GPU.
    if (W < 420) return 9;
    if (W < 700) return 13;
    return 18;
  }

  function build() {
    const n = nodeCount();
    nodes = Array.from({ length: n }, (_, i) => ({
      // Normalised home position, so a resize repositions rather than rebuilds.
      hx: rand(0.06, 0.94),
      hy: rand(0.1, 0.9),
      z: rand(0, 1),
      // Independent phase and period per node so the drift never looks like a
      // single synchronised wave.
      phase: rand(0, Math.PI * 2),
      period: rand(9000, 19000),
      ampX: rand(4, 13),
      ampY: rand(3, 10),
      // A few accent nodes. Fixed indices rather than random so the composition
      // is stable across reloads.
      accent: i % 5 === 2,
    }));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: 3x costs a lot for no visible gain
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (nodes.length !== nodeCount()) build();
  }

  /** Rendered position of a node, including drift and depth-scaled parallax. */
  function positionOf(node, t) {
    const driftX = Math.sin(t / node.period + node.phase) * node.ampX;
    const driftY = Math.cos(t / (node.period * 1.31) + node.phase) * node.ampY;
    return {
      x: node.hx * W + driftX + par.curX * node.z * MAX_SHIFT,
      y: node.hy * H + driftY + par.curY * node.z * MAX_SHIFT,
    };
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);

    const pts = nodes.map((n) => ({ n, ...positionOf(n, t) }));
    const threshold = Math.min(W, H) * 0.52;

    // --- connections first, so nodes sit on top of the lines
    ctx.lineWidth = 1;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const a = pts[i];
        const b = pts[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > threshold) continue;

        // Fade with distance, and with how far back the pair sits.
        const avgZ = (a.n.z + b.n.z) / 2;
        const alpha = (1 - dist / threshold) * (0.1 + avgZ * 0.26);
        if (alpha < 0.012) continue;

        const accentPair = a.n.accent && b.n.accent;
        const [r, g, bl] = accentPair ? ACCENT : PLAIN;
        ctx.strokeStyle = `rgba(${r}, ${g}, ${bl}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // --- nodes, far to near, so nearer ones overlap correctly
    const ordered = [...pts].sort((p, q) => p.n.z - q.n.z);
    let lastBlur = -1;

    for (const { n, x, y } of ordered) {
      const radius = 2 + n.z * 5;
      const alpha = 0.34 + n.z * 0.42;

      // Depth of field: far nodes very slightly soft. Only touch ctx.filter
      // when it actually changes — it is a relatively costly state change.
      const blur = Math.round((1 - n.z) * 1.5 * 10) / 10;
      if (blur !== lastBlur) {
        ctx.filter = blur >= 0.3 ? `blur(${blur}px)` : 'none';
        lastBlur = blur;
      }

      // Light from the top-left, so each node reads as a small sphere rather
      // than a flat dot.
      const [r, g, bl] = n.accent ? ACCENT : PLAIN;
      const grad = ctx.createRadialGradient(
        x - radius * 0.38,
        y - radius * 0.38,
        radius * 0.1,
        x,
        y,
        radius,
      );
      grad.addColorStop(0, `rgba(${Math.min(r + 40, 255)}, ${Math.min(g + 40, 255)}, ${Math.min(bl + 40, 255)}, ${alpha})`);
      grad.addColorStop(0.55, `rgba(${r}, ${g}, ${bl}, ${alpha * 0.8})`);
      grad.addColorStop(1, `rgba(${Math.round(r * 0.35)}, ${Math.round(g * 0.35)}, ${Math.round(bl * 0.35)}, 0)`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.filter = 'none';
  }

  function frame(t) {
    // Ease toward the pointer target; the same easing walks it back to 0 when
    // the cursor leaves, so nothing snaps.
    par.curX += (par.targetX - par.curX) * 0.06;
    par.curY += (par.targetY - par.curY) * 0.06;
    draw(t);
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (rafId !== null || reduceMotion.matches) return;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  /** Static single frame — used under reduced-motion and on resize while paused. */
  function renderStatic() {
    par.curX = 0;
    par.curY = 0;
    draw(0);
  }

  function applyMotionPreference() {
    if (reduceMotion.matches) {
      stop();
      renderStatic();
    } else if (visible) {
      start();
    }
  }

  // ------------------------------------------------------------- listeners

  host.addEventListener('pointermove', (event) => {
    if (reduceMotion.matches) return;
    const rect = host.getBoundingClientRect();
    // -1..1 from the centre of the hero area.
    par.targetX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    par.targetY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  });

  host.addEventListener('pointerleave', () => {
    par.targetX = 0;
    par.targetY = 0;
  });

  // Only burn frames while the hero is actually on screen.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        if (visible) applyMotionPreference();
        else stop();
      },
      { threshold: 0 },
    ).observe(canvas);
  }

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      resize();
      if (rafId === null) renderStatic();
    }).observe(canvas);
  } else {
    window.addEventListener('resize', resize);
  }

  // Chrome fires `change`; older Safari only has addListener.
  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener('change', applyMotionPreference);
  } else if (reduceMotion.addListener) {
    reduceMotion.addListener(applyMotionPreference);
  }

  // The picker can be re-shown via "Interview another candidate"; restart then.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else applyMotionPreference();
  });

  resize();
  build();
  resize();
  // Paint one frame synchronously before handing over to rAF. Without this the
  // canvas is blank until the first animation frame fires — which can be a
  // visible beat, and never at all if the tab is backgrounded or the compositor
  // is idle at load.
  renderStatic();
  applyMotionPreference();
})();
