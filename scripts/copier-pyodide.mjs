/**
 * EMBARQUE PYODIDE DANS LES ASSETS DE L'APPLI — zéro CDN au lancement.
 *
 * Pyodide, c'est CPython compilé en WebAssembly. Son chargeur (`pyodide.mjs`)
 * va chercher ses fichiers à `indexURL` : le noyau (`pyodide.asm.wasm`), sa
 * glu JavaScript (`pyodide.asm.js`), la bibliothèque standard zippée
 * (`python_stdlib.zip`) et l'index des paquets (`pyodide-lock.json`). Sans
 * `indexURL`, il irait sur jsdelivr — l'appli est souveraine, donc les cinq
 * fichiers sont COPIÉS ici depuis `node_modules/pyodide` vers `public/pyodide/`,
 * d'où Vite les recopie tels quels dans `dist/client/pyodide/`, puis Capacitor
 * dans l'APK (`assets/public/pyodide/`). L'appli les charge ensuite par
 * `https://localhost/pyodide/…`, servi depuis l'APK : aucune requête sortante.
 *
 * Le dossier `public/pyodide/` n'est PAS versionné (12 Mo de binaires) : ce
 * script tourne à `postinstall` et avant chaque `build:spa`. Il ÉCHOUE si un
 * fichier manque — on ne construit pas une appli qui promet Python sans lui.
 *
 * Il écrit aussi `manifeste.json` (version, Python, octets par fichier) : c'est
 * ce que l'écran affiche pendant le chargement (« 12 285 651 octets à lire »),
 * un chiffre MESURÉ à la construction, jamais écrit en dur dans l'interface.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(racine, "node_modules", "pyodide");
const cible = join(racine, "public", "pyodide");

/** Les CINQ fichiers que `loadPyodide({ indexURL })` lit au démarrage, et rien d'autre. */
const FICHIERS = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

if (!existsSync(source)) {
  console.error(`copier-pyodide : ${source} introuvable — lance \`npm install\` d'abord.`);
  process.exit(1);
}

const paquet = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const verrou = JSON.parse(readFileSync(join(source, "pyodide-lock.json"), "utf8"));
mkdirSync(cible, { recursive: true });

let total = 0;
const fichiers = [];
for (const nom of FICHIERS) {
  const de = join(source, nom);
  if (!existsSync(de)) {
    console.error(`copier-pyodide : ${de} manque dans le paquet pyodide@${paquet.version}.`);
    process.exit(1);
  }
  const vers = join(cible, nom);
  const octets = statSync(de).size;
  // Copie seulement si différent (taille ou contenu) : le script est idempotent
  // et ne réécrit pas 12 Mo à chaque `npm install`.
  const identique =
    existsSync(vers) &&
    statSync(vers).size === octets &&
    createHash("sha256").update(readFileSync(vers)).digest("hex") ===
      createHash("sha256").update(readFileSync(de)).digest("hex");
  if (!identique) copyFileSync(de, vers);
  total += octets;
  fichiers.push({ nom, octets });
  console.log(`  ${nom.padEnd(20)} ${String(octets).padStart(10)} octets${identique ? "  (déjà à jour)" : ""}`);
}

const manifeste = {
  pyodide: paquet.version,
  python: verrou?.info?.python ?? null,
  fichiers,
  total,
  // Ce qui N'EST PAS embarqué, dit noir sur blanc : aucun paquet de l'index
  // (numpy, matplotlib, pandas…) — seule la bibliothèque standard.
  paquetsEmbarques: [],
};
writeFileSync(join(cible, "manifeste.json"), JSON.stringify(manifeste, null, 2));
console.log(`copier-pyodide : Pyodide ${paquet.version} (Python ${manifeste.python}) → public/pyodide/, ${total} octets au total, aucun paquet supplémentaire.`);
