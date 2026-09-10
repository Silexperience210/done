import { Code2, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession, type StudioTab } from "@/store/session";

export function StudioPanel() {
  const studio = useSession((s) => s.studio);
  const tab = useSession((s) => s.studioTab);
  const setTab = useSession((s) => s.setStudioTab);

  return (
    <section className="flex h-phone w-full min-w-0 max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-elevated">
      <StudioChrome title={studio?.title ?? "Studio"} tab={tab} onTab={setTab} />
      <div className="relative min-h-0 flex-1">
        {studio ? (
          <StudioBody html={studio.html} tab={tab} />
        ) : (
          <div className="flex h-full flex-col justify-end p-5">
            <p className="text-sm text-muted text-pretty">
              Ask Edge0 to write a game or a page. The source lands here so you can
              read it and run it on-device.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export function StudioOverlay() {
  const studio = useSession((s) => s.studio);
  const tab = useSession((s) => s.studioTab);
  const setTab = useSession((s) => s.setStudioTab);
  const close = useSession((s) => s.closeStudio);
  if (!studio) return null;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-screen">
      <div className="flex items-center gap-1 px-2 py-2">
        <button
          type="button"
          onClick={close}
          className="flex size-10 items-center justify-center rounded-full text-fg"
          aria-label="Close studio"
        >
          <X className="size-5" strokeWidth={1.75} />
        </button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{studio.title}</p>
      </div>
      <div className="px-3 pb-2">
        <TabSwitch tab={tab} onTab={setTab} />
      </div>
      <div className="relative min-h-0 flex-1">
        <StudioBody html={studio.html} tab={tab} />
      </div>
    </div>
  );
}

function StudioChrome({
  title,
  tab,
  onTab,
}: {
  title: string;
  tab: StudioTab;
  onTab: (t: StudioTab) => void;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
      <div className="min-w-0">
        <p className="font-mono text-xs tracking-widest text-muted uppercase">Studio</p>
        <p className="truncate text-sm font-medium text-fg">{title}</p>
      </div>
      <TabSwitch tab={tab} onTab={onTab} />
    </header>
  );
}

function TabSwitch({ tab, onTab }: { tab: StudioTab; onTab: (t: StudioTab) => void }) {
  return (
    <div className="flex rounded-full bg-surface p-0.5">
      {(
        [
          { id: "preview", label: "Run", Icon: Play },
          { id: "code", label: "Code", Icon: Code2 },
        ] as const
      ).map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onTab(id)}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium",
            tab === id ? "bg-bubble text-fg" : "text-muted",
          )}
        >
          <Icon className="size-3" strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  );
}

function StudioBody({ html, tab }: { html: string; tab: StudioTab }) {
  return (
    <>
      <iframe
        title="On-device studio"
        sandbox="allow-scripts"
        srcDoc={html}
        className={cn(
          "absolute inset-0 h-full w-full border-0 bg-screen",
          tab === "code" && "invisible",
        )}
      />
      {tab === "code" && (
        <pre className="absolute inset-0 overflow-auto p-4 font-mono text-xs leading-relaxed text-stat">
          {prettyHtml(html)}
        </pre>
      )}
    </>
  );
}

function prettyHtml(html: string) {
  return html
    .replace(/></g, ">\n<")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}
