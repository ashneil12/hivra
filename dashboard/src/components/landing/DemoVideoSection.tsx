"use client";

import { useRef } from "react";
import { AnimateIn } from "@/components/ui/animate-in";
import dynamic from 'next/dynamic';

const MuxPlayer = dynamic(() => import('@mux/mux-player-react'), { ssr: false });

// Add type definition to avoid any
import type MuxPlayerElement from "@mux/mux-player";

export default function DemoVideoSection() {
  const playerRef = useRef<MuxPlayerElement>(null);

  const handleVideoClick = () => {
    const player = playerRef.current;
    if (!player) return;
    
    // Toggle play/pause
    if (player.paused) {
      player.play();
    } else {
      player.pause();
    }
  };

  const handleDoubleClick = () => {
    const player = playerRef.current;
    if (!player) return;

    // Toggle fullscreen
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else if (player.requestFullscreen) {
      player.requestFullscreen();
    } else {
      const p = player as unknown as { webkitRequestFullscreen?: () => void };
      if (p.webkitRequestFullscreen) p.webkitRequestFullscreen();
    }
  };

  return (
    <section id="demo" style={{ width: "100%", maxWidth: 1000, padding: "0 clamp(1rem, 5vw, 2rem)", zIndex: 10, margin: "0 auto 4rem" }}>
      <AnimateIn>
        <div 
          onClick={handleVideoClick}
          onDoubleClick={handleDoubleClick}
          style={{ 
            padding: 8, 
            background: "var(--overlay-bg)", 
            border: "1px solid var(--etched-border)", 
            backdropFilter: "blur(12px)",
            boxShadow: "0 20px 40px rgba(0, 0, 0, 0.08)"
          }}
        >
          <MuxPlayer
            ref={playerRef}
            playbackId="64DvZTtxFjyBIkkvk01JYc02fqa020201C8aKms34b15b702I"
            envKey="g26agtgf6apdeotaithn1ac5r"
            metadata={{
              video_title: "Hivra Demo"
            }}
            loop
            autoPlay="muted"
            muted
            accentColor="#c5a059"
            style={{ 
              width: "100%", 
              aspectRatio: "735 / 478", 
              display: "block",
              cursor: "pointer",
              /* Using CSS variables specific to MuxPlayer to hide the bottom bar while retaining click-to-play */
              "--controls": "none"
            }}
          />
        </div>
      </AnimateIn>
    </section>
  );
}
