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

// AndroidStatusBar (et les icônes SignalIcon / WifiIcon / BatteryIcon) SUPPRIMÉS.
//
// C'était un faux masque de barre d'état de téléphone : il PEIGNAIT une heure
// figée (« 9:41 », qui n'est jamais l'heure réelle), un réseau (« 5G », qui
// n'est pas mesuré — et qui n'existe même pas forcément), et une batterie pleine
// inventée. Rien de tout cela n'était lu sur l'appareil : c'était un décor de
// maquette, exactement ce que l'utilisateur a signalé comme « fake ».
// Aucun de ces éléments n'est remplacé : une vraie barre d'état est déjà dessinée
// par Android au-dessus de l'appli. On ne redessine pas des chiffres faux.

export function AndroidNav() {
  return (
    <div className="flex h-5 shrink-0 items-start justify-center pt-1">
      <span className="h-1 w-28 rounded-full bg-fg/55" />
    </div>
  );
}
