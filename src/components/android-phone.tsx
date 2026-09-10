import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AndroidPhone({
  children,
  frameless = false,
}: {
  children: ReactNode;
  frameless?: boolean;
}) {
  if (frameless) {
    return (
      <div className="relative flex h-dvh min-h-dvh w-full flex-col bg-screen font-android text-fg">
        {children}
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        className={cn(
          "relative h-phone aspect-phone bg-phone p-2.5",
          "shadow-[0_50px_90px_-30px_rgba(0,0,0,0.9)]",
        )}
        style={{ borderRadius: "var(--radius-phone)" }}
      >
        <span className="absolute top-24 -left-px h-14 w-1 rounded-r-sm bg-fg/20" />
        <span className="absolute top-40 -left-px h-8 w-1 rounded-r-sm bg-fg/20" />
        <span className="absolute top-32 -right-px h-16 w-1 rounded-l-sm bg-fg/25" />
        <div
          className="relative flex h-full min-h-0 flex-col overflow-hidden bg-screen font-android"
          style={{ borderRadius: "var(--radius-screen)" }}
        >
          <span className="absolute top-2.5 left-1/2 z-30 size-3 -translate-x-1/2 rounded-full bg-phone ring-2 ring-fg/15" />
          {children}
        </div>
      </div>
    </div>
  );
}

export function AndroidStatusBar() {
  return (
    <div className="relative z-20 flex h-10 shrink-0 items-end px-5 pb-1 text-fg">
      <time className="flex-1 font-android text-xs font-medium tabular-nums">9:41</time>
      <div className="flex items-center gap-1.5">
        <SignalIcon />
        <span className="text-xs font-medium tracking-wide">5G</span>
        <WifiIcon />
        <BatteryIcon />
      </div>
    </div>
  );
}

function SignalIcon() {
  return (
    <svg viewBox="0 0 14 12" className="h-3 w-3.5" aria-hidden>
      <rect x="0" y="8" width="2.2" height="4" rx="0.4" fill="currentColor" opacity="0.45" />
      <rect x="3.6" y="5.5" width="2.2" height="6.5" rx="0.4" fill="currentColor" opacity="0.7" />
      <rect x="7.2" y="3" width="2.2" height="9" rx="0.4" fill="currentColor" />
      <rect x="10.8" y="0.5" width="2.2" height="11.5" rx="0.4" fill="currentColor" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg viewBox="0 0 16 12" className="h-3 w-4" fill="none" aria-hidden>
      <path
        d="M1 4.2c4-3.6 10-3.6 14 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M3.6 6.6c2.6-2.2 6.2-2.2 8.8 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M6.3 9c1-0.9 2.4-0.9 3.4 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11" r="0.9" fill="currentColor" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg viewBox="0 0 24 12" className="h-3 w-6" aria-hidden>
      <rect
        x="0.6"
        y="1"
        width="20"
        height="10"
        rx="2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="2" y="2.6" width="15.5" height="6.8" rx="1.2" fill="currentColor" />
      <rect x="21.4" y="4" width="1.8" height="4" rx="0.6" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

export function AndroidNav() {
  return (
    <div className="flex h-5 shrink-0 items-start justify-center pt-1">
      <span className="h-1 w-28 rounded-full bg-fg/55" />
    </div>
  );
}
