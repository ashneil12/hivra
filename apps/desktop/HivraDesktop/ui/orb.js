// A small dotted "thinking orb" (the website's activity indicator), drawn on
// a canvas: dots on a slowly turning sphere. Still when Reduce motion is on.
export function mountOrb(canvas, size = 48) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.height = size * ratio;
  canvas.style.width = canvas.style.height = `${size}px`;
  const context = canvas.getContext("2d");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dots = [];
  const count = 90;
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    dots.push([Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
  }
  let frame = 0;
  const draw = (time) => {
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--hg-fg").trim() || "#222";
    context.clearRect(0, 0, canvas.width, canvas.height);
    const angle = still ? 0.6 : time / 1600;
    const centre = canvas.width / 2;
    const scale = canvas.width * 0.42;
    for (const [x, y, z] of dots) {
      const rx = x * Math.cos(angle) + z * Math.sin(angle);
      const rz = -x * Math.sin(angle) + z * Math.cos(angle);
      const ty = y * Math.cos(0.4) - rz * Math.sin(0.4);
      const tz = y * Math.sin(0.4) + rz * Math.cos(0.4);
      const depth = (tz + 1) / 2;
      context.globalAlpha = 0.18 + depth * 0.72;
      context.fillStyle = ink;
      context.beginPath();
      context.arc(centre + rx * scale, centre + ty * scale, (0.8 + depth * 1.3) * ratio, 0, Math.PI * 2);
      context.fill();
    }
    if (!still) frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(frame);
}
