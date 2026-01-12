import { useEffect, useRef } from 'react';

type ParticlesBackgroundProps = {
  dark: boolean;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function ParticlesBackground({ dark }: ParticlesBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const prefersReduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    const isCoarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    const hoverable = window.matchMedia?.('(hover: hover)')?.matches ?? false;
    const enableInteraction = hoverable && !isCoarsePointer;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let disposed = false;
    let particles: Particle[] = [];

    const pointer = {
      x: 0,
      y: 0,
      active: false,
      lastMoveAt: 0
    };

    const targetCountFor = (w: number, h: number) => {
      const area = w * h;
      return clamp(Math.floor(area / 14_000), 30, 110);
    };

    const reseed = (count: number) => {
      const next: Particle[] = [];
      for (let i = 0; i < count; i += 1) {
        const baseSpeed = 0.12 + Math.random() * 0.28;
        const angle = Math.random() * Math.PI * 2;
        next.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: Math.cos(angle) * baseSpeed,
          vy: Math.sin(angle) * baseSpeed,
          r: 1.1 + Math.random() * 1.8
        });
      }
      particles = next;
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const target = targetCountFor(width, height);
      if (particles.length === 0) reseed(target);
      else if (particles.length !== target) {
        reseed(target);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      // Canvas is pointer-events:none so listen on window and translate to canvas coords.
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
      pointer.lastMoveAt = performance.now();
    };

    const visibilityOk = () => document.visibilityState !== 'hidden';

    const step = () => {
      if (disposed) return;
      raf = window.requestAnimationFrame(step);
      if (!visibilityOk()) return;

      ctx.clearRect(0, 0, width, height);

      const dotColor = dark ? 'rgba(255,255,255,0.48)' : 'rgba(0,0,0,0.28)';
      const lineColorBase = dark ? [255, 255, 255] : [0, 0, 0];

      const linkDist = 120;
      const linkDist2 = linkDist * linkDist;
      const pointerRadius = 140;
      const pointerRadius2 = pointerRadius * pointerRadius;

      const now = performance.now();
      if (pointer.active && now - pointer.lastMoveAt > 1200) pointer.active = false;

      const motionFactor = prefersReduceMotion ? 0.25 : 1;
      for (const p of particles) {
        p.x += p.vx * motionFactor;
        p.y += p.vy * motionFactor;

        if (p.x < -10) p.x = width + 10;
        else if (p.x > width + 10) p.x = -10;
        if (p.y < -10) p.y = height + 10;
        else if (p.y > height + 10) p.y = -10;

        if (!prefersReduceMotion && enableInteraction && pointer.active) {
          const dx = pointer.x - p.x;
          const dy = pointer.y - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < pointerRadius2 && d2 > 1e-3) {
            const d = Math.sqrt(d2);
            const strength = (1 - d / pointerRadius) * 0.045;
            p.vx += (dx / d) * strength;
            p.vy += (dy / d) * strength;
          }
        }
        p.vx *= 0.985;
        p.vy *= 0.985;
      }

      // Links (cheap O(n^2) with low n); skip under reduce-motion.
      if (!prefersReduceMotion) {
        for (let i = 0; i < particles.length; i += 1) {
          const a = particles[i];
          for (let j = i + 1; j < particles.length; j += 1) {
            const b = particles[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > linkDist2) continue;
            const alpha = (1 - d2 / linkDist2) * (dark ? 0.22 : 0.12);
            ctx.strokeStyle = `rgba(${lineColorBase[0]},${lineColorBase[1]},${lineColorBase[2]},${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      ctx.fillStyle = dotColor;
      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    if (enableInteraction) window.addEventListener('pointermove', onPointerMove, { passive: true });
    raf = window.requestAnimationFrame(step);

    return () => {
      disposed = true;
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
      if (enableInteraction) window.removeEventListener('pointermove', onPointerMove);
    };
  }, [dark]);

  return <canvas ref={canvasRef} className="particlesCanvas" aria-hidden="true" />;
}
