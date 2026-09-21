'use client';

import React from 'react';
import { createPortal } from 'react-dom';

interface SafePortalProps {
  children: React.ReactNode;
  container?: HTMLElement | null;
}

export function SafePortal({ children, container }: SafePortalProps) {
  const [mountNode, setMountNode] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    if (container) {
      setMountNode(container);
      return;
    }

    const target = document.body;
    if (!target) {
      return;
    }

    const portalRoot = document.createElement('div');
    portalRoot.setAttribute('data-hermes-portal-root', '');
    // Anchor the portal root at viewport (0,0) so descendants that compute
    // position from the parent's bounding rect (react-rnd's Draggable does
    // this) don't get pushed off-screen when body uses a flex column with
    // h-[100dvh] and the appended root naturally lands at offsetTop = body
    // height. position:absolute (not fixed) avoids creating a stacking
    // context with z-index:auto that would trap descendants' z-index below
    // sibling app content.
    portalRoot.style.position = 'absolute';
    portalRoot.style.top = '0';
    portalRoot.style.left = '0';
    target.appendChild(portalRoot);
    setMountNode(portalRoot);

    return () => {
      if (portalRoot.isConnected) {
        portalRoot.remove();
      }
    };
  }, [container]);

  if (!mountNode) {
    return null;
  }

  return createPortal(children, mountNode);
}
