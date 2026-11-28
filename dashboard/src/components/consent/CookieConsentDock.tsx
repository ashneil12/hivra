'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

const SetConsentDock = createContext<((node: HTMLDivElement | null) => void) | null>(null);
const ConsentDock = createContext<HTMLDivElement | null>(null);

export function CookieConsentDockProvider({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  return (
    <SetConsentDock.Provider value={setDock}>
      <ConsentDock.Provider value={dock}>{children}</ConsentDock.Provider>
    </SetConsentDock.Provider>
  );
}

export function CookieConsentDock() {
  const setDock = useContext(SetConsentDock);
  return setDock ? <div ref={setDock} style={{ display: 'contents' }} /> : null;
}

export function useCookieConsentDock() {
  return useContext(ConsentDock);
}
