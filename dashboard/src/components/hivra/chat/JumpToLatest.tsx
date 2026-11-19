"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// MonoCode's jump-to-bottom: a small round chevron that floats over the
// composer when the reader has scrolled up. Its name stays "Return to latest".

import { ChevronDown } from "lucide-react";
import styles from "./chat.module.css";

export function JumpToLatest({ onJump }: { onJump: () => void }) {
  return (
    <div className={styles.jumpWrap}>
      <button type="button" aria-label="Return to latest" title="Return to latest" onClick={onJump} className={styles.jump}>
        <ChevronDown size={16} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
