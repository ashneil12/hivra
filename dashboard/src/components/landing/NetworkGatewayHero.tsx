/**
 * NetworkGatewayHero — the hero centerpiece.
 *
 * Renders the Hivra "H" gateway as a glowing node at the centre of a small
 * agent network: animated red signal lines fan out to the agent nodes
 * (Claude Code + Hermes Agent online, Codex / OpenClaw / AEON coming soon).
 *
 * Pure SVG + CSS (animations live in globals.css under `.hivra-net`), so it
 * renders as a server component and works in both light and dark themes. The
 * gateway plinth is intentionally dark in both themes — matching the brand
 * mark — so the white barcode bars and red "H" read consistently.
 */

type NodeStatus = "online" | "soon";

interface AgentNode {
  name: string;
  status: NodeStatus;
  /** Anchor point in the 400×400 SVG/diagram coordinate space. */
  x: number;
  y: number;
}

const NODES: AgentNode[] = [
  { name: "Hermes Agent", status: "online", x: 80, y: 62 },
  { name: "Claude Code", status: "online", x: 322, y: 56 },
  { name: "Codex", status: "soon", x: 338, y: 208 },
  { name: "AEON", status: "soon", x: 298, y: 346 },
  { name: "OpenClaw", status: "soon", x: 74, y: 322 },
];

const CENTER = { x: 200, y: 200 };

function GatewayMark() {
  // Brand barcode-H: white bars + red H, drawn on the dark plinth.
  return (
    <svg
      viewBox="0 0 150 156"
      width="100%"
      height="100%"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <g fill="#fdfcf9">
        <path d="m1.5 1.5v35.5h4.2v9.2h-4.2v108.8h6.8v-109.1h1.9v109.1h1.5v-153.5h-10.2z" />
        <path d="m15.6 1.5v153.5h2.3v-133.9-19.6h-2.3z" />
        <path d="m20.5 1.5v153.8h2.4v-34.3h2.5v-75.1h-2.5v-44.4h-2.4z" />
        <path d="m28 1.5v44.4h2.4v-44.4h-2.4z" />
        <path d="m33.1 1.5v44.4h-2.5v75.1h-2.6v34h7.6v-153.5h-2.5z" />
        <path d="m40.7 1.5v30.5h15.5v-30.5h-15.5z" />
        <path d="m61.3 1.5v35.5h4.9v16.7h-4.9v17.4h7.3v-69.6h-7.3z" />
        <path d="m73.6 1.5v20.8h2.3v14.7h-2.3v34.1h7.2v-69.6h-7.2z" />
        <path d="m86.1 1.5v69.6h4l0.2-69.6h-4.2z" />
        <path d="m91.2 1.5 0.1 69.6h2.5v-69.6h-2.6z" />
        <path d="m98.8 1.5v30.4h2.5v-30.4h-2.5z" />
        <path d="m106.2 1.5v30.4h2.7v-30.4h-2.7z" />
        <path d="m116.8 1.5v153.5h4.7l-0.1-34h-2.4v-84.1h2.5v84.1h1.4v-84h2.6v-35.5h-8.7z" />
        <path d="m130.7 1.5-0.1 35.5h2.7v84h-5.1v-84.1h-1.6v84.1h-2.7v34h10.8l-0.1-118.1h2.5l-0.1 118.1h2.3l0.8-153.5h-9.4z" />
        <path d="m141.6 1.5v35.4h2.5l-0.1 84.1h4.5v-119.5h-6.9z" />
        <path d="m144 121v9.3h4.5v24.7h-6.9v-34h2.4z" />
        <path d="m43.2 130.3-0.1 24.6h2.5v-24.6h-2.4z" />
        <path d="m50.8 130.3 0.1 24.7h5.3v-24.7h-5.4z" />
        <path d="m61.3 91v64h7.3v-64h-7.3z" />
        <path d="m73.6 91v25h7.2v-25h-7.2z" />
        <path d="m86.1 91v33.7h5.2l0.1 30.2h2.4v-63.9h-7.7z" />
        <path d="m98.8 130.3v24.7h3.8v-24.7h-3.8z" />
        <path d="m106.2 130.3v24.7h5.2v-24.7h-5.2z" />
      </g>
      <g fill="var(--hivra-red)">
        <path d="m40.6 37.2v87.6h7.9v-38.9h5v38.9h2.7v-38.9h42.6v38.9h4.9v-87.6h-4.9v39.2h-42.7l0.1-39.2h-2.8l0.1 39.2h-5v-39.2h-7.9z" />
        <path d="m106.3 64.1h3.3v-26.9h1.8v39.1h-5.2l0.1-12.2z" />
        <path d="m106.2 91h5.2v33.8h-5.2v-33.8z" />
      </g>
    </svg>
  );
}

export default function NetworkGatewayHero() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 460,
        aspectRatio: "1 / 1",
        margin: "0 auto",
      }}
    >
      {/* Ambient red glow behind the gateway */}
      <div
        style={{
          position: "absolute",
          inset: "18%",
          background:
            "radial-gradient(circle at 50% 50%, var(--hivra-red-soft), transparent 70%)",
          filter: "blur(8px)",
          pointerEvents: "none",
        }}
      />

      {/* Connection lines */}
      <svg
        viewBox="0 0 400 400"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {NODES.map((node) => (
          <line
            key={`line-${node.name}`}
            className="gateway-line"
            x1={CENTER.x}
            y1={CENTER.y}
            x2={node.x}
            y2={node.y}
            opacity={node.status === "online" ? 1 : 0.5}
          />
        ))}
        {/* Anchor dots where lines meet each node */}
        {NODES.map((node) => (
          <circle
            key={`dot-${node.name}`}
            cx={node.x}
            cy={node.y}
            r={3}
            fill="var(--hivra-red)"
            opacity={node.status === "online" ? 0.9 : 0.4}
          />
        ))}
        <circle className="gateway-pulse" cx={CENTER.x} cy={CENTER.y} r={64} opacity={0.12} />
      </svg>

      {/* Agent nodes */}
      {NODES.map((node) => {
        const online = node.status === "online";
        return (
          <div
            key={node.name}
            style={{
              position: "absolute",
              left: `${(node.x / 400) * 100}%`,
              top: `${(node.y / 400) * 100}%`,
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              gap: 5,
              padding: "9px 12px",
              minWidth: 96,
              background: "var(--bg-surface)",
              border: `1px solid ${online ? "var(--hivra-red-line)" : "var(--etched-border)"}`,
              boxShadow: online ? "0 0 22px -10px var(--hivra-red-glow)" : "none",
              backdropFilter: "blur(6px)",
            }}
          >
            <span
              className="serif"
              style={{
                fontSize: 12,
                fontWeight: 700,
                lineHeight: 1.1,
                color: "var(--ink-black)",
                whiteSpace: "nowrap",
              }}
            >
              {node.name}
            </span>
            <span className={`node-status ${online ? "is-online" : "is-soon"}`}>
              <span className="dot" />
              {online ? "Online" : "Soon"}
            </span>
          </div>
        );
      })}

      {/* Central gateway node */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: "26%",
          minWidth: 92,
          aspectRatio: "150 / 156",
          padding: 16,
          background: "#0c0c0c",
          border: "1px solid var(--hivra-red-line)",
          boxShadow:
            "0 0 0 6px rgba(255,44,45,0.04), 0 0 60px -10px var(--hivra-red-glow), 0 30px 60px -24px rgba(0,0,0,0.6)",
        }}
      >
        <GatewayMark />
      </div>
    </div>
  );
}
