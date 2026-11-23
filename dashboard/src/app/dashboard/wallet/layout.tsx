import { Suspense, type ReactNode } from "react";

import { HolderSwitchNotice } from "@/components/claim/HolderSwitchNotice";

export default function WalletLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <HolderSwitchNotice className="mx-auto mt-[calc(var(--dashboard-page-safe-top,0px)+1rem)] w-[calc(100%-3rem)] max-w-[864px]" />
      </Suspense>
      {children}
    </>
  );
}
