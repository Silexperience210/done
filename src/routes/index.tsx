import { createFileRoute } from "@tanstack/react-router";
import { NativeShell, Stage } from "@/components/stage";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main>
      <h1 className="sr-only">
        Qwen2.5-Coder-1.5B qui tourne dans ta page, hors ligne
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
