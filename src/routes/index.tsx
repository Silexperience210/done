import { createFileRoute } from "@tanstack/react-router";
import { NativeShell, Stage } from "@/components/stage";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main>
      <h1 className="sr-only">
        Studio local — un petit modèle de code exécuté sur ton appareil, hors ligne
      </h1>
      <div className="hidden min-h-dvh lg:block">
        <Stage />
      </div>
      <div className="lg:hidden">
        <NativeShell />
      </div>
    </main>
  );
}
