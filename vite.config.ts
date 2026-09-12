import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { grokPwaPlugin } from "./scripts/grok-pwa-plugin.mjs";
// @ts-expect-error JS plugin alongside the TS vite config
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
import { isMigrationFile } from "./scripts/migration-plan.mjs";

/** The files `src/lib/db.ts` globs — same directory, same non-recursive scope. */
function hasGlobbedMigrations(root: string): boolean {
  try {
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/lib/db` kicks `ensureDbReady`
 * on import.
 *
 * Vite awaiting the hook puts this on time-to-first-render, so an app with no
 * migrations — no schema to apply — skips it entirely rather than paying for a
 * PGLite instance it never queries.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

/**
 * Live-preview OAuth popup — handled HERE so the agent never has to create a
 * `/auth/popup` route (and cannot break it by scaffolding a React page that
 * paints the full app shell in the popup).
 *
 * `signIn` (client.ts) opens `/auth/popup?providerId=…` in a top-level window.
 * This middleware runs before TanStack Start, calls `handleAuthPopupRequest`,
 * and returns the 302 / completion HTML. Deployed apps do not use the popup
 * (full-page OAuth redirect), so `apply: "serve"` is enough.
 */
function authPopupPlugin(): Plugin {
  return {
    name: "app-builder:auth-popup",
    apply: "serve",
    configureServer(server) {
      // Register immediately (not in a returned post-hook) so we run BEFORE
      // TanStack Start / the SPA HTML fallback. A model-authored
      // `src/routes/auth/popup.tsx` React page must never win this path.
      server.middlewares.use(async (req, res, next) => {
        try {
          const rawUrl = req.url ?? "";
          const pathOnly = rawUrl.split("?", 1)[0] ?? "";
          if (pathOnly !== "/auth/popup") {
            next();
            return;
          }
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            res.statusCode = 405;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Method Not Allowed");
            return;
          }

          const host = String(
            req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080",
          );
          const proto = String(
            req.headers["x-forwarded-proto"] ??
              ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http"),
          );
          const requestHeaders = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) requestHeaders.append(key, v);
            } else {
              requestHeaders.set(key, value);
            }
          }
          // Ensure Host is the public preview host so Better Auth's dynamic
          // baseURL / redirect_uri match the popup origin.
          if (!requestHeaders.has("host")) requestHeaders.set("host", host);

          const request = new Request(`${proto}://${host}${rawUrl}`, {
            method: "GET",
            headers: requestHeaders,
          });

          const mod = (await server.ssrLoadModule("/src/lib/auth/popup.server.ts")) as {
            handleAuthPopupRequest: (req: Request) => Promise<Response>;
          };
          const response = await mod.handleAuthPopupRequest(request);

          res.statusCode = response.status;
          // Preserve multiple Set-Cookie headers (OAuth state + session).
          const setCookies =
            typeof response.headers.getSetCookie === "function"
              ? response.headers.getSetCookie()
              : [];
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() === "set-cookie") return;
            res.setHeader(key, value);
          });
          for (const cookie of setCookies) {
            res.appendHeader("set-cookie", cookie);
          }
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        } catch (err) {
          console.error("[app-builder] /auth/popup handler failed:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("auth popup failed");
          }
        }
      });
    },
  };
}

// `0.0.0.0:8080` is the live-preview contract — don't change host/port.
// The dev server starts once `src/router.tsx` and `src/routes/` exist — see
// AGENTS.md § "First scaffold".
export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
    // Le contrôle d'hôte de Vite bloque par défaut tout Host inconnu (403
    // « Blocked request »). On autorise le domaine des tunnels rapides
    // Cloudflare — et SEULEMENT lui : `true` désactiverait la protection
    // contre le DNS rebinding, ce qui n'est pas nécessaire ici.
    allowedHosts: [".trycloudflare.com"],
  },
  resolve: {
    tsconfigPaths: true,
    // BUILD_SPA=1 → build STATIQUE pour l'APK. Dans l'appli empaquetée, le
    // moteur navigateur (WebGPU / transformers.js) est du code MORT :
    // `capacitesReelles()` voit Capacitor, donc `choisirMoteur` renvoie
    // TOUJOURS « natif ». On alias `@/ai/localModel` vers une doublure vide afin
    // que `@huggingface/transformers` et `onnxruntime` ne soient PAS embarqués —
    // ~21 Mo de WASM (ort-wasm-simd-threaded.asyncify-*.wasm) et 4 alertes de
    // sécurité graves (adm-zip, sharp/libvips) en moins.
    //
    // Le seul import RUNTIME de `localModel.ts` est le `import()` dynamique du
    // store (`chargerMoteurWebgpu`, jamais atteint en natif) : aliaser le module
    // sort toute la chaîne du graphe. Sans BUILD_SPA, la clé `alias` n'existe
    // MÊME PAS : le build navigateur garde un `resolve` STRICTEMENT identique.
    ...(process.env.BUILD_SPA === "1"
      ? {
          alias: [
            {
              find: /^@\/ai\/localModel$/,
              replacement: fileURLToPath(new URL("./src/ai/localModel.absent.ts", import.meta.url)),
            },
          ],
        }
      : {}),
  },
  plugins: [
    // SSL DÉSACTIVÉ : le plugin @vitejs/plugin-basic-ssl casse le middleware SSR
    // de TanStack Start (toutes les routes renvoient « Cannot GET / », même
    // /login — la pile passe en HTTP/2 et le SSR n'est plus atteint).
    // Pour WebGPU sur le téléphone, on utilise l'exception d'origine de Chrome
    // (chrome://flags/#unsafely-treat-insecure-origin-as-secure) sur l'URL HTTP.
    // ...(command === "serve" ? [basicSsl()] : []),
    pgliteBootstrapPlugin(),
    // Before tanstackStart so /auth/popup never falls through to the SPA.
    authPopupPlugin(),
    // Dev-only /__app-env, read by scripts/check-auth-invariant.mjs.
    appEnvPlugin(),
    // PWA head + ?install=1 tutorial page; runs before Start/Nitro.
    grokPwaPlugin(),
    tailwindcss(),
    tanstackStart(
      // BUILD_SPA=1 → sortie STATIQUE (mode SPA de TanStack Start), la seule
      // forme utilisable par Capacitor : un APK n'a pas de serveur pour rendre
      // les pages. Sans cette variable, rien ne change.
      process.env.BUILD_SPA === "1"
        ? {
            spa: {
              enabled: true,
              // Le pré-rendu interroge cette route : « / », pas « /index.html »
              // (l'appli n'expose que « / » ; demander /index.html donne un 404
              // et fait échouer tout le build).
              maskPath: "/",
              prerender: {
                enabled: true,
                outputPath: "index.html",
                crawlLinks: false,
                retryCount: 0,
              },
            },
          }
        : {},
    ),
    ...(process.env.BUILD_SPA !== "1" && (command === "build" || isPreview)
      ? [
          nitro({
            // AUTO-HÉBERGÉ, et non « vercel ». Le preset « vercel » produisait un
            // paquet lié à un hébergeur : impossible à lancer sur la machine de
            // l'utilisateur. « node-server » produit un serveur Node autonome
            // (`node .output/server/index.mjs`), donc un déploiement réellement
            // local.
            preset: "node-server",
            // Auto-registers server/middleware/* (the PWA install page +
            // manifest + head-tag middleware). Nitro v3 defaults serverDir to
            // false, so removing this silently unwires /?install=1 on deploys.
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
}));
