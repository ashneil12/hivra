"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// Files dropped anywhere on the chat pane attach to its composer. MonoCode also
// takes native (Tauri) drops and drags from its file explorer; the browser only
// has DOM drops. Returns whether a file is being dragged over the pane.

import { useEffect, useRef, useState, type RefObject } from "react";

function hasFiles(data: DataTransfer | null): data is DataTransfer {
  if (!data) return false;
  return (
    (data.files?.length ?? 0) > 0 ||
    [...(data.types || [])].some((type) => type === "Files" || type === "application/x-moz-file") ||
    Array.from(data.items ?? []).some((item) => item.kind === "file")
  );
}

export function useFileDrop({ root, enabled, onFiles }: {
  /** The pane the files may land on. */
  root: RefObject<HTMLElement | null>;
  /** Without a token the computer takes no uploads, so a drop does nothing. */
  enabled: boolean;
  onFiles: (files: File[]) => void;
}): boolean {
  const [fileDrag, setFileDrag] = useState(false);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  });

  useEffect(() => {
    const pane = root.current;
    if (!pane) return;
    const onDragOver = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (!hasFiles(data)) return;
      event.preventDefault();
      data.dropEffect = enabled ? "copy" : "none";
      setFileDrag(enabled);
    };
    const onDragLeave = (event: DragEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && pane.contains(next)) return;
      setFileDrag(false);
    };
    const onDrop = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (!hasFiles(data)) return;
      event.preventDefault();
      setFileDrag(false);
      if (!enabled) return;
      const files = Array.from(data.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };
    pane.addEventListener("dragover", onDragOver);
    pane.addEventListener("dragleave", onDragLeave);
    pane.addEventListener("drop", onDrop);
    return () => {
      pane.removeEventListener("dragover", onDragOver);
      pane.removeEventListener("dragleave", onDragLeave);
      pane.removeEventListener("drop", onDrop);
      setFileDrag(false);
    };
  }, [root, enabled]);

  return fileDrag;
}
