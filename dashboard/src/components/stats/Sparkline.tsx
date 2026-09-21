"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

interface SparklinePoint {
  date: string;
  count: number;
}

interface SparklineLabels {
  peak: string;
  total: string;
  /** Template string with `{date}` and `{count}` placeholders. */
  barLabel: string;
}

interface SparklineProps {
  data: SparklinePoint[];
  height?: number;
  locale?: string;
  labels?: SparklineLabels;
  ariaLabel?: string;
  /**
   * "bars" (default) = one bar per day. "area" = a cumulative growth curve
   * (running total) with a gradient fill — reads cleanly even when the daily
   * data is sparse, so it's used on the public marketing page.
   */
  variant?: "bars" | "area";
}

const PADDING_X = 8;
const PADDING_TOP = 14;
const PADDING_BOTTOM = 24;
const VIEWBOX_WIDTH = 1000;
const MIN_BAR_HEIGHT = 3;

const DEFAULT_LABELS: SparklineLabels = {
  peak: "peak day",
  total: "30-day total",
  barLabel: "{date}: {count} deploys",
};

export function Sparkline({
  data,
  height = 160,
  locale = "en-US",
  labels = DEFAULT_LABELS,
  ariaLabel,
  variant = "bars",
}: SparklineProps) {
  const reduceMotion = useReducedMotion();
  const [hovered, setHovered] = useState<number | null>(null);

  // The "area" variant renders 1:1 to its measured pixel width so the line and
  // endpoint dot stay crisp/round (no non-uniform SVG stretch). Bars mode keeps
  // the fixed 1000-unit viewBox and ignores this.
  const wrapRef = useRef<HTMLElement | null>(null);
  const [measuredW, setMeasuredW] = useState(960);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setMeasuredW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { bars, max, total, firstDate, lastDate, midDate, axisY } = useMemo(() => {
    const max = Math.max(1, ...data.map((d) => d.count));
    const total = data.reduce((sum, d) => sum + d.count, 0);
    const usableWidth = VIEWBOX_WIDTH - PADDING_X * 2;
    const barSlot = data.length > 0 ? usableWidth / data.length : 0;
    const barWidth = Math.max(2, barSlot * 0.6);
    const usableHeight = height - PADDING_TOP - PADDING_BOTTOM;
    const axisY = PADDING_TOP + usableHeight;
    const bars = data.map((d, i) => {
      const rawH = (d.count / max) * usableHeight;
      const h = d.count > 0 ? Math.max(MIN_BAR_HEIGHT, rawH) : 0;
      return {
        x: PADDING_X + i * barSlot + (barSlot - barWidth) / 2,
        y: axisY - h,
        width: barWidth,
        height: h,
        date: d.date,
        count: d.count,
      };
    });
    return {
      bars,
      max,
      total,
      firstDate: data[0]?.date ?? null,
      lastDate: data[data.length - 1]?.date ?? null,
      midDate: data[Math.floor(data.length / 2)]?.date ?? null,
      axisY,
    };
  }, [data, height]);

  const areaView = useMemo(() => {
    const w = Math.max(320, measuredW);
    const usableWidth = w - PADDING_X * 2;
    const usableHeight = height - PADDING_TOP - PADDING_BOTTOM;
    const axisY = PADDING_TOP + usableHeight;
    const n = data.length;
    const cum = data.map((_, i) => data.slice(0, i + 1).reduce((s, d) => s + d.count, 0));
    const yMax = Math.max(1, n > 0 ? cum[n - 1] : 0) * 1.12; // headroom so the curve doesn't kiss the top
    const xAt = (i: number) =>
      PADDING_X + (n <= 1 ? usableWidth : (usableWidth * i) / (n - 1));
    const yAt = (v: number) => axisY - (v / yMax) * usableHeight;
    const pts = data.map((d, i) => ({ x: xAt(i), y: yAt(cum[i]), date: d.date, count: d.count }));
    const linePath = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    const areaPath = pts.length
      ? `M${pts[0].x.toFixed(1)},${axisY.toFixed(1)} ` +
        pts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
        ` L${pts[n - 1].x.toFixed(1)},${axisY.toFixed(1)} Z`
      : "";
    const grid = [0.33, 0.66, 1].map((f) => axisY - f * usableHeight);
    const slot = n > 0 ? usableWidth / n : usableWidth;
    return { w, axisY, pts, linePath, areaPath, grid, slot, last: pts[n - 1] ?? null };
  }, [data, height, measuredW]);

  const formatDate = (iso: string) => {
    try {
      return new Date(iso + "T00:00:00Z").toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    } catch {
      return iso.slice(5);
    }
  };

  const formatBarTitle = (iso: string, count: number) =>
    labels.barLabel
      .replace("{date}", formatDate(iso))
      .replace("{count}", count.toLocaleString(locale));

  if (variant === "area") {
    return (
      <figure ref={wrapRef} style={{ width: "100%", margin: 0 }} aria-label={ariaLabel}>
        <svg
          viewBox={`0 0 ${areaView.w} ${height}`}
          preserveAspectRatio="none"
          style={{ display: "block", width: "100%", height }}
          role="img"
        >
          <defs>
            <linearGradient id="hermesAreaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--gold-leaf)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--gold-leaf)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {areaView.grid.map((gy, i) => (
            <line
              key={`grid-${i}`}
              x1={PADDING_X}
              x2={areaView.w - PADDING_X}
              y1={gy}
              y2={gy}
              stroke="var(--etched-border)"
              strokeWidth="1"
              strokeDasharray="2 5"
              opacity={0.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <line
            x1={PADDING_X}
            x2={areaView.w - PADDING_X}
            y1={areaView.axisY}
            y2={areaView.axisY}
            stroke="var(--etched-border)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />

          {areaView.areaPath && (
            <motion.path
              d={areaView.areaPath}
              fill="url(#hermesAreaFill)"
              initial={reduceMotion ? false : { opacity: 0 }}
              whileInView={reduceMotion ? undefined : { opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.7, ease: "easeOut" }}
            />
          )}

          {areaView.linePath && (
            <motion.path
              d={areaView.linePath}
              fill="none"
              stroke="var(--gold-leaf)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              initial={reduceMotion ? false : { pathLength: 0 }}
              whileInView={reduceMotion ? undefined : { pathLength: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.9, ease: "easeOut" }}
            />
          )}

          {areaView.last && (
            <>
              {!reduceMotion && (
                <motion.circle
                  cx={areaView.last.x}
                  cy={areaView.last.y}
                  fill="none"
                  stroke="var(--gold-leaf)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  initial={{ r: 4, opacity: 0.7 }}
                  animate={{ r: 13, opacity: 0 }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }}
                />
              )}
              <circle cx={areaView.last.x} cy={areaView.last.y} r="3.5" fill="var(--gold-leaf)" />
            </>
          )}

          {hovered != null && areaView.pts[hovered] && (
            <g>
              <line
                x1={areaView.pts[hovered].x}
                x2={areaView.pts[hovered].x}
                y1={PADDING_TOP}
                y2={areaView.axisY}
                stroke="var(--gold-leaf)"
                strokeWidth="1"
                opacity="0.45"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={areaView.pts[hovered].x} cy={areaView.pts[hovered].y} r="3" fill="var(--gold-leaf)" />
            </g>
          )}

          {areaView.pts.map((p, i) => (
            <rect
              key={`hit-${p.date}-${i}`}
              x={p.x - areaView.slot / 2}
              y={PADDING_TOP}
              width={areaView.slot}
              height={areaView.axisY - PADDING_TOP}
              fill="transparent"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
              tabIndex={0}
              style={{ cursor: "pointer", outline: "none" }}
            >
              <title>{formatBarTitle(p.date, p.count)}</title>
            </rect>
          ))}

          {firstDate && (
            <text x={PADDING_X} y={height - 8} fontSize="10" fontFamily="var(--font-mono), monospace" fill="var(--text-muted)" textAnchor="start">
              {formatDate(firstDate)}
            </text>
          )}
          {midDate && (
            <text x={areaView.w / 2} y={height - 8} fontSize="10" fontFamily="var(--font-mono), monospace" fill="var(--text-muted)" textAnchor="middle">
              {formatDate(midDate)}
            </text>
          )}
          {lastDate && (
            <text x={areaView.w - PADDING_X} y={height - 8} fontSize="10" fontFamily="var(--font-mono), monospace" fill="var(--text-muted)" textAnchor="end">
              {formatDate(lastDate)}
            </text>
          )}
        </svg>

        <figcaption
          className="mono"
          style={{
            marginTop: "1.25rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.16em",
            color: "var(--text-muted)",
          }}
        >
          <span>{labels.peak}: {max.toLocaleString(locale)}</span>
          <span>{labels.total}: {total.toLocaleString(locale)}</span>
        </figcaption>
      </figure>
    );
  }

  return (
    <figure
      style={{ width: "100%", margin: 0 }}
      aria-label={ariaLabel}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
        preserveAspectRatio="none"
        style={{ display: "block", width: "100%", height }}
        role="img"
      >
        <defs>
          <linearGradient id="hermesBarGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--gold-leaf)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--gold-leaf)" stopOpacity="0.55" />
          </linearGradient>
        </defs>

        <line
          x1={PADDING_X}
          x2={VIEWBOX_WIDTH - PADDING_X}
          y1={axisY}
          y2={axisY}
          stroke="var(--etched-border)"
          strokeWidth="1"
        />

        {bars.map((bar, i) => {
          const isHovered = hovered === i;
          return (
            <g key={`${bar.date}-${i}`}>
              <motion.rect
                x={bar.x}
                width={bar.width}
                y={bar.y}
                height={bar.height}
                rx={bar.width > 6 ? 1.5 : 0}
                fill="url(#hermesBarGradient)"
                opacity={bar.count === 0 ? 0 : isHovered ? 1 : 0.85}
                initial={reduceMotion ? false : { opacity: 0 }}
                whileInView={reduceMotion ? undefined : { opacity: bar.count === 0 ? 0 : 0.85 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.015, ease: "easeOut" }}
              />
              <rect
                x={bar.x - 2}
                y={PADDING_TOP}
                width={bar.width + 4}
                height={axisY - PADDING_TOP}
                fill="transparent"
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered(null)}
                tabIndex={0}
                style={{ cursor: "pointer", outline: "none" }}
              >
                <title>{formatBarTitle(bar.date, bar.count)}</title>
              </rect>
            </g>
          );
        })}

        {firstDate && (
          <text
            x={PADDING_X}
            y={height - 8}
            fontSize="10"
            fontFamily="var(--font-mono), monospace"
            fill="var(--text-muted)"
            textAnchor="start"
          >
            {formatDate(firstDate)}
          </text>
        )}
        {midDate && (
          <text
            x={VIEWBOX_WIDTH / 2}
            y={height - 8}
            fontSize="10"
            fontFamily="var(--font-mono), monospace"
            fill="var(--text-muted)"
            textAnchor="middle"
          >
            {formatDate(midDate)}
          </text>
        )}
        {lastDate && (
          <text
            x={VIEWBOX_WIDTH - PADDING_X}
            y={height - 8}
            fontSize="10"
            fontFamily="var(--font-mono), monospace"
            fill="var(--text-muted)"
            textAnchor="end"
          >
            {formatDate(lastDate)}
          </text>
        )}
      </svg>

      <figcaption
        className="mono"
        style={{
          marginTop: "1.25rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.16em",
          color: "var(--text-muted)",
        }}
      >
        <span>{labels.peak}: {max.toLocaleString(locale)}</span>
        <span>{labels.total}: {total.toLocaleString(locale)}</span>
      </figcaption>
    </figure>
  );
}
