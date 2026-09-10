import { createFileRoute } from "@tanstack/react-router";
import { NativeShell, Stage } from "@/components/stage";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main>
      <h1 className="sr-only">
        Edge0 on Android — a 35B language model with tools and a 4 GB working set
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
