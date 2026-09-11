import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Configuration de l'appli empaquetée (APK Android via Capacitor).
 *
 * Ce qui compte ici :
 *
 *  - `webDir` pointe sur la sortie **statique** (`npm run build:spa`), pas sur
 *    le serveur Node. Un APK n'a pas de serveur pour rendre les pages : l'appli
 *    embarque des fichiers, et c'est le mode SPA de TanStack Start qui les
 *    produit.
 *  - `androidScheme: "https"` donne à la WebView une **origine sécurisée**.
 *    Sans ça, pas de géolocalisation ni de WebAssembly côté page.
 *  - `allowMixedContent: false` : rien n'autorise le mélange http/https. Tout
 *    ce qui tourne là-dedans doit rester local au téléphone.
 */
const config: CapacitorConfig = {
  appId: "org.silexperience.studiolocal",
  appName: "Studio local",
  webDir: "dist/client",
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
