import { useEffect, useRef } from 'react';

// Ambient background: a slow GPU-only glow layer (CSS transforms) and a
// canvas of drifting, softly connected nodes kept to the window edges, so
// the centre where the leads table sits stays calm.
//
// Cost control: about 24 fps while a search runs, 12 fps when idle; stops
// entirely when the window is hidden or unfocused; one static frame when
// the system asks for reduced motion.

const NODES = 34;
const LINK = 130;

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  return { node: cs.getPropertyValue('--ambient-node').trim(), line: cs.getPropertyValue('--ambient-line').trim() };
}

export default function Ambient({ active }) {
  const canvasRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let w = 0;
    let h = 0;
    let nodes = [];
    let colors = readColors();
    let raf = 0;
    let last = 0;
    let running = false;

    // Nodes live in the outer bands of the window (left and right ~18%).
    const band = () => Math.max(120, w * 0.18);
    const spawn = (i) => {
      const left = i % 2 === 0;
      const b = band();
      return {
        x: left ? Math.random() * b : w - Math.random() * b,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
        r: 1 + Math.random() * 1.4,
        left,
      };
    };

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      nodes = Array.from({ length: NODES }, (_, i) => spawn(i));
      draw(0);
    }

    function step(dt) {
      const b = band();
      for (const n of nodes) {
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        const min = n.left ? 0 : w - b;
        const max = n.left ? b : w;
        if (n.x < min || n.x > max) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
      }
    }

    function draw(dt) {
      if (dt) step(dt);
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const c = nodes[j];
          const d = Math.hypot(a.x - c.x, a.y - c.y);
          if (d < LINK) {
            ctx.globalAlpha = (1 - d / LINK) * 0.55;
            ctx.strokeStyle = colors.line;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(c.x, c.y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.node;
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function frame(now) {
      raf = 0;
      if (!running) return;
      const interval = activeRef.current ? 1000 / 24 : 1000 / 12;
      if (now - last >= interval) {
        const dt = last ? Math.min(now - last, 100) / 16.7 : 1;
        last = now;
        draw(dt);
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (running || reduce.matches || document.hidden || !document.hasFocus()) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    const onVisibility = () => (document.hidden ? stop() : start());
    const onMotion = () => (reduce.matches ? (stop(), draw(0)) : start());
    const onTheme = () => {
      colors = readColors();
      draw(0);
    };

    resize();
    start();
    window.addEventListener('resize', resize);
    window.addEventListener('focus', start);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', onVisibility);
    reduce.addEventListener('change', onMotion);
    window.addEventListener('themechange', onTheme);
    window.__ambient = { isRunning: () => running }; // for tests
    return () => {
      stop();
      window.removeEventListener('resize', resize);
      window.removeEventListener('focus', start);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', onVisibility);
      reduce.removeEventListener('change', onMotion);
      window.removeEventListener('themechange', onTheme);
    };
  }, []);

  return (
    <div className="ambient" aria-hidden="true">
      <div className="ambient-glow glow-a" />
      <div className="ambient-glow glow-b" />
      <canvas ref={canvasRef} className="ambient-canvas" />
    </div>
  );
}
