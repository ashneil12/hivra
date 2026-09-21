"use client";

import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

import {
  getInteractiveBackgroundParticleCount,
  shouldPauseInteractiveBackground,
} from './interactive-background-config';
import { clientLog } from '@/lib/client/logger';

interface InteractiveBackgroundProps {
  densityMultiplier?: number;
  maxParticles?: number;
  /**
   * Base RGB triplet (e.g. "255, 44, 45") used for the particle dots and the
   * lines that connect them. Defaults to the vellum/gold accent so existing
   * callers are unchanged; the Hivra Network landing passes red.
   */
  accentRgb?: string;
}

type NavigatorWithConnection = Navigator & {
  connection?: {
    saveData?: boolean;
  };
};

function getCanvasRenderingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

function readMediaQueryMatch(query: string): boolean {
  try {
    return window.matchMedia?.(query).matches ?? false;
  } catch (error) {
    clientLog.warn(
      'Interactive background media query failed',
      {
        source: 'interactive-background',
        failureType: 'interactive_background_media_query_failed',
        query,
      },
      error
    );
    return false;
  }
}

function readSaveDataPreference(): boolean {
  try {
    return (navigator as NavigatorWithConnection).connection?.saveData === true;
  } catch (error) {
    clientLog.warn(
      'Interactive background save-data preference read failed',
      {
        source: 'interactive-background',
        failureType: 'interactive_background_save_data_read_failed',
      },
      error
    );
    return false;
  }
}

class Particle {
  x: number;
  y: number;
  size: number;
  vx: number;
  vy: number;
  density: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.vx = (Math.random() - 0.5) * 0.5;
    this.vy = (Math.random() - 0.5) * 0.5;
    this.size = Math.random() * 2 + 1;
    this.density = Math.random() * 30 + 1;
  }

  draw(ctx: CanvasRenderingContext2D, accentRgb: string) {
    ctx.fillStyle = `rgba(${accentRgb}, 0.4)`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  }

  update(mouse: { x: number | null; y: number | null; radius: number }, canvasWidth: number, canvasHeight: number) {
    this.x += this.vx;
    this.y += this.vy;

    if (this.x < 0) this.x = canvasWidth;
    if (this.x > canvasWidth) this.x = 0;
    if (this.y < 0) this.y = canvasHeight;
    if (this.y > canvasHeight) this.y = 0;

    const dx = (mouse.x || 0) - this.x;
    const dy = (mouse.y || 0) - this.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (mouse.x !== null && distance < mouse.radius) {
      const forceDirectionX = distance > 0 ? dx / distance : 0;
      const forceDirectionY = distance > 0 ? dy / distance : 0;
      const maxDistance = mouse.radius;
      const force = (maxDistance - distance) / maxDistance;
      const directionX = forceDirectionX * force * this.density * 0.2;
      const directionY = forceDirectionY * force * this.density * 0.2;

      this.x -= directionX;
      this.y -= directionY;
    }
  }
}

const DEFAULT_ACCENT_RGB = '255, 44, 45'; // vellum/gold

function InteractiveBackground({
  densityMultiplier = 1,
  maxParticles,
  accentRgb = DEFAULT_ACCENT_RGB,
}: InteractiveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = getCanvasRenderingContext(canvas);
    if (!ctx) return;

    let particlesArray: Particle[] = [];
    let animationFrameId = 0;
    let isAnimating = false;

    const prefersReducedMotion = readMediaQueryMatch("(prefers-reduced-motion: reduce)");
    const coarsePointer = readMediaQueryMatch("(pointer: coarse)");
    const saveData = readSaveDataPreference();

    const mouse = {
      x: null as number | null,
      y: null as number | null,
      radius: coarsePointer ? 72 : 120
    };

    let isPaused = shouldPauseInteractiveBackground({
      hidden: document.hidden,
      prefersReducedMotion,
      saveData,
    });

    const handleMouseMove = (event: MouseEvent) => {
      mouse.x = event.x;
      mouse.y = event.y;
    };

    const handleMouseLeave = () => {
      mouse.x = null;
      mouse.y = null;
    };

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      init();
      if (!isPaused) {
        startAnimation();
      }
    };

    const handleVisibilityChange = () => {
      isPaused = shouldPauseInteractiveBackground({
        hidden: document.hidden,
        prefersReducedMotion,
        saveData,
      });

      if (isPaused) {
        stopAnimation();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      startAnimation();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('resize', handleResize);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    function init() {
      if (!canvas) return;
      particlesArray = [];
      const numberOfParticles = getInteractiveBackgroundParticleCount({
        width: canvas.width,
        height: canvas.height,
        coarsePointer,
        prefersReducedMotion,
        saveData,
        densityMultiplier,
        maxParticles,
      });
      for (let i = 0; i < numberOfParticles; i++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        particlesArray.push(new Particle(x, y));
      }
    }

    function connect() {
      if (!ctx) return;
      for (let a = 0; a < particlesArray.length; a++) {
        for (let b = a + 1; b < particlesArray.length; b++) { // Optimized inner loop start
          const dx = particlesArray[a].x - particlesArray[b].x;
          const dy = particlesArray[a].y - particlesArray[b].y;
          const distSq = dx * dx + dy * dy;
          
          if (distSq < 12100) { // 110^2
            const distance = Math.sqrt(distSq);
            const opacityValue = 1 - distance / 110;
            ctx.strokeStyle = `rgba(${accentRgb}, ${opacityValue * 0.2})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(particlesArray[a].x, particlesArray[a].y);
            ctx.lineTo(particlesArray[b].x, particlesArray[b].y);
            ctx.stroke();
          }
        }
      }
    }

    function animate() {
      if (!ctx || !canvas || isPaused) {
        isAnimating = false;
        animationFrameId = 0;
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < particlesArray.length; i++) {
        particlesArray[i].draw(ctx, accentRgb);
        particlesArray[i].update(mouse, canvas.width, canvas.height);
      }
      connect();
      animationFrameId = requestAnimationFrame(animate);
    }

    function startAnimation() {
      if (isAnimating || isPaused || particlesArray.length === 0) return;
      isAnimating = true;
      animationFrameId = requestAnimationFrame(animate);
    }

    function stopAnimation() {
      if (!animationFrameId) {
        isAnimating = false;
        return;
      }
      cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
      isAnimating = false;
    }

    handleResize();
    if (!isPaused) {
      startAnimation();
    }

    return () => {
      stopAnimation();
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [densityMultiplier, maxParticles, accentRgb]);

  return (
    <motion.canvas
      ref={canvasRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.5, ease: "easeInOut" }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 0
      }}
      aria-hidden="true"
    />
  );
}

export default React.memo(InteractiveBackground);
