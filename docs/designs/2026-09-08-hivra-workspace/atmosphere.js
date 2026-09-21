// Hivra's red particle network: decorative only, never a resource-state indicator.
// Bounded at 36 points/24 fps; reduced motion draws one static frame.
(() => {
  const canvas = document.querySelector(".ambient-network");
  const context = canvas?.getContext("2d");
  if (!context) return;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0;
  let height = 0;
  let points = [];
  let frame = 0;
  let previous = 0;
  let lastDraw = 0;

  function resize() {
    width = canvas.clientWidth || innerWidth;
    height = canvas.clientHeight || innerHeight;
    const scale = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const count = Math.min(
      36,
      Math.max(12, Math.round((width * height) / 29000)),
    );
    points = Array.from({ length: count }, (_, i) => ({
      // Deterministic spread avoids a distracting rearrangement on every render.
      x: ((i * 0.61803398875 + 0.12) % 1) * width,
      y: ((i * 0.38196601125 + (i % 3) * 0.19) % 1) * height,
      vx: Math.sin(i * 2.4) * 3,
      vy: Math.cos(i * 1.8) * 2.3,
      radius: i % 4 === 0 ? 1.8 : 1.1,
    }));
    draw(0);
  }

  function draw(delta) {
    context.clearRect(0, 0, width, height);
    const light = document.documentElement.dataset.theme === "light";
    const red = light ? "210, 28, 32" : "255, 58, 59";
    points.forEach((point) => {
      point.x = (point.x + point.vx * delta + width) % width;
      point.y = (point.y + point.vy * delta + height) % height;
    });
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      for (let j = i + 1; j < points.length; j++) {
        const q = points[j];
        const distance = Math.hypot(p.x - q.x, p.y - q.y);
        if (distance > 155) continue;
        context.strokeStyle = `rgba(${red},${(1 - distance / 155) * 0.2})`;
        context.lineWidth = 0.6;
        context.beginPath();
        context.moveTo(p.x, p.y);
        context.lineTo(q.x, q.y);
        context.stroke();
      }
      context.fillStyle = `rgba(${red},${light ? 0.38 : 0.58})`;
      context.beginPath();
      context.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  function tick(now) {
    if (now - lastDraw >= 1000 / 24) {
      draw(previous ? Math.min((now - previous) / 1000, 0.08) : 0);
      previous = now;
      lastDraw = now;
    }
    frame = requestAnimationFrame(tick);
  }

  function updateMotion() {
    cancelAnimationFrame(frame);
    previous = 0;
    lastDraw = 0;
    draw(0);
    if (!reduceMotion.matches && !document.hidden)
      frame = requestAnimationFrame(tick);
  }

  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", updateMotion);
  reduceMotion.addEventListener("change", updateMotion);
  new MutationObserver(() => draw(0)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  resize();
  updateMotion();
})();
