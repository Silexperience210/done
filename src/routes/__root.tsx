import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
// La TRACE de démarrage (fichier lisible sur le téléphone) est lancée ici, au
// tout premier rendu : elle doit exister AVANT qu'on ait besoin d'elle pour
// diagnostiquer un chargement bloqué. Voir src/ai/journal.ts.
import { JournalDemarrage } from "@/components/journal-demarrage";
// LA TRACE NATIVE à l'écran : le fichier écrit par jni.cpp (voir
// patches/llama-cpp-capacitor+0.1.5+003+diagnostic-natif.patch) vit dans la
// mémoire privée de l'appli — illisible par un gestionnaire de fichiers, et cet
// appareil n'a ni `adb` ni rapport de bug. Ce panneau est donc le seul lecteur.
import { TraceNative } from "@/components/trace-native";
import appCss from "../styles.css?url";

const APP_NAME = "Studio local";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: APP_NAME },
      {
        name: "description",
        content:
          "Un petit modèle de langage exécuté sur l'appareil, hors ligne. Une seule requête sortante : le téléchargement du modèle.",
      },
      { name: "theme-color", content: "#070708" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
      // POLICES GOOGLE RETIRÉES : elles chargeaient fonts.googleapis.com et
      // fonts.gstatic.com sur chaque page. L'appli doit n'émettre aucun appel
      // sortant ; on s'appuie sur les polices du système (voir styles.css).
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        <JournalDemarrage />
        <TraceNative />
        <PreviewHostBridge />
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
