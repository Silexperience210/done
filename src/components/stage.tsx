import { MODELS } from "@/lib/edge0";
import { useSession } from "@/store/session";
import { AndroidPhone } from "./android-phone";
import { Edge0App } from "./edge0-app";
import { EnginePanel } from "./engine-viz";
import { StudioPanel } from "./studio";

export function Stage() {
  const model = useSession((s) => s.model);
  const streaming = useSession((s) => s.streaming);
  const memoryGb = useSession((s) => s.memoryGb);
  const tokPerSec = useSession((s) => s.tokPerSec);
  const profile = MODELS[model];
  const last = useSession((s) => s.messages.at(-1));

  return (
    <div className="relative min-h-dvh bg-bg text-fg">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_40%_at_50%_-10%,rgba(216,220,228,0.07),transparent_55%)]" />

      <div className="relative mx-auto grid min-h-dvh max-w-7xl grid-cols-1 items-center gap-6 px-5 py-6 lg:grid-cols-[minmax(15rem,0.85fr)_auto_minmax(22rem,1.15fr)] lg:gap-8 lg:px-8">
        <div className="hidden lg:block">
          <p className="font-mono text-xs tracking-widest text-muted uppercase">
            Edge0 · Android
          </p>
          <p className="mt-3 text-2xl font-medium tracking-tight text-balance xl:text-3xl">
            A {profile.short} model on a phone.
            <span className="mt-2 block text-muted">Peak working set {profile.activeGb}.</span>
          </p>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted text-pretty">
            Tools, thinking, and a studio to read and run generated code — all
            inside a {profile.peakGb.toFixed(0)} GB envelope.
          </p>
          <div className="mt-6">
            <EnginePanel
              model={model}
              streaming={streaming}
              memoryGb={memoryGb}
              tokPerSec={tokPerSec}
            />
          </div>
          {last?.role === "assistant" && (last.tools?.length || last.thinking) ? (
            <p className="mt-4 font-mono text-xs text-muted">
              {streaming ? "decode / tools live" : "last turn"}
              {last.tools?.length ? ` · ${last.tools.length} tool call${last.tools.length > 1 ? "s" : ""}` : ""}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col items-center">
          <AndroidPhone>
            <Edge0App />
          </AndroidPhone>
        </div>

        <aside className="hidden min-w-0 lg:flex lg:justify-end">
          <StudioPanel />
        </aside>
      </div>
    </div>
  );
}

export function NativeShell() {
  return (
    <div className="h-dvh bg-screen">
      <AndroidPhone frameless>
        <Edge0App overlay />
      </AndroidPhone>
    </div>
  );
}
