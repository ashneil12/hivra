"use client";

import { Play } from "lucide-react";
import { useRef, useState } from "react";
import styles from "@/app/venice/venice.module.css";

export default function VeniceLaunchFilm({ src, poster }: { src: string; poster: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const [started, setStarted] = useState(false);

  return (
    <div className={styles.film}>
      <video
        ref={video}
        aria-label="Hivra × Venice launch film"
        width={960}
        height={540}
        poster={poster}
        controls
        playsInline
        preload="none"
        onPlaying={(event) => {
          if (document.activeElement === playButton.current) event.currentTarget.focus();
          setStarted(true);
        }}
      >
        <source src={src} type="video/mp4" />
        <a href={src}>Download the Hivra × Venice launch film</a>
      </video>
      {!started && (
        <button
          ref={playButton}
          type="button"
          className={styles.filmPlay}
          aria-label="Play Hivra × Venice launch film"
          onClick={() => { void video.current?.play().catch(() => {}); }}
        >
          <Play aria-hidden="true" size={23} fill="currentColor" />
        </button>
      )}
    </div>
  );
}
