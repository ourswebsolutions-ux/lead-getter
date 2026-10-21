import { useEffect, useRef } from 'react';
import Icon from './icons.jsx';

// End-of-search card with the real counts sent by the main process (taken
// from the database). A short, restrained confetti burst only when new
// leads were found, and never under reduced motion.

function confetti(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = (canvas.width = window.innerWidth * dpr);
  const h = (canvas.height = window.innerHeight * dpr);
  const cs = getComputedStyle(document.documentElement);
  const palette = ['--accent', '--wa', '--warn', '--text-2'].map((v) => cs.getPropertyValue(v).trim());
  const cx = w / 2;
  const cy = 120 * dpr;
  const parts = Array.from({ length: 70 }, () => {
    const a = Math.random() * Math.PI - Math.PI; // upward fan
    const speed = (3 + Math.random() * 5) * dpr;
    return { x: cx, y: cy, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, s: (3 + Math.random() * 3) * dpr, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, c: palette[Math.floor(Math.random() * palette.length)] };
  });
  const t0 = performance.now();
  let raf;
  const tick = (now) => {
    const t = (now - t0) / 1400;
    ctx.clearRect(0, 0, w, h);
    if (t >= 1) return;
    ctx.globalAlpha = 1 - t * t;
    for (const p of parts) {
      p.vy += 0.16 * dpr;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

export default function Celebration({ summary, onClose }) {
  const canvasRef = useRef(null);
  const { outcome, newLeads, processed, alreadySaved, started } = summary;
  const celebrate = outcome === 'done' && newLeads > 0;

  useEffect(() => {
    if (!celebrate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    return confetti(canvasRef.current);
  }, [celebrate]);

  useEffect(() => {
    const t = setTimeout(onClose, 12_000);
    return () => clearTimeout(t);
  }, [onClose]);

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let title;
  let line;
  if (outcome === 'done') {
    title = 'Search completed!';
    line = newLeads > 0 ? `Congratulations! You found ${plural(newLeads, 'potential client', 'potential clients')} today.` : 'No new businesses without a website this time.';
  } else if (!started) {
    title = 'Search stopped';
    line = 'Stopped before the search began. Nothing was changed.';
  } else {
    title = 'Search stopped';
    line = newLeads > 0 ? `${plural(newLeads, 'qualified lead', 'qualified leads')} saved successfully.` : 'No new qualified leads were found before stopping.';
  }

  return (
    <>
      {celebrate && <canvas ref={canvasRef} className="confetti" aria-hidden="true" />}
      <div className={`celebration ${celebrate ? 'is-win' : ''}`} role="status" aria-live="polite">
        <span className="celebration-icon">
          <Icon name={outcome === 'done' ? 'check' : 'stop'} size={18} />
        </span>
        <div className="celebration-body">
          <strong>{title}</strong>
          <p>{line}</p>
          {started && (
            <dl className="celebration-stats">
              <div>
                <dt>New leads</dt>
                <dd className="num">{newLeads}</dd>
              </div>
              <div>
                <dt>Listings processed</dt>
                <dd className="num">{processed}</dd>
              </div>
              <div>
                <dt>Already saved</dt>
                <dd className="num">{alreadySaved}</dd>
              </div>
            </dl>
          )}
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </>
  );
}
