/**
 * LE BOUTON QUI DÉBLOQUE TOUT : importer dans l'appli le modèle que l'utilisateur
 * a déjà téléchargé avec Chrome (voir `src/ai/importerModele.ts`).
 *
 * POURQUOI IL EST LÀ, À CET ENDROIT : l'appli ne peut RIEN lire dans le stockage
 * partagé (elle n'a que la permission INTERNET) et son propre téléchargeur ne
 * rend pas la main sur cet appareil. La seule voie qui reste doit donc être
 * visible À L'ÉCRAN, à l'endroit exact où l'utilisateur constate que le modèle
 * manque — pas dans un menu.
 *
 * LE MODÈLE EST DÉDUIT DE LA TAILLE DU FICHIER, pas demandé à l'utilisateur : les
 * trois modèles ont des tailles distinctes (0,40 Go / 1,0 Go / 8,0 Go, mesurées
 * sur le Hub), et c'est de toute façon la seule chose qui compte — le nom écrit
 * sur le disque est celui que le moteur cherchera, jamais celui du fichier
 * téléchargé (Chrome le nomme d'après une empreinte, « 589f….bin »).
 *
 * IL NE DÉPEND D'AUCUN RÉSEAU : le fichier est déjà sur le téléphone, le
 * sélecteur Android accorde la lecture du fichier choisi sans permission de
 * stockage, et l'écriture se fait dans la mémoire privée de l'appli.
 */

import { useRef, useState } from "react";
import { importerModeleDepuisFichier, tailleAcceptable, type ProgresImport } from "@/ai/importerModele";
import {
  telechargerModeleParFetch,
  type ProgresTelechargement,
} from "@/ai/telechargementModele";
import { MODELES_GGUF, modeleGguf } from "@/ai/moteurNatif";
import { useSession } from "@/store/session";

function tailleLisible(octets: number): string {
  if (octets >= 1e9) return `${(octets / 1e9).toFixed(2)} Go`;
  return `${(octets / 1e6).toFixed(0)} Mo`;
}

type Etat = "repos" | "ecriture" | "ok" | "erreur";

export function ImporterModele() {
  const champ = useRef<HTMLInputElement | null>(null);
  const [etat, setEtat] = useState<Etat>("repos");
  const [progres, setProgres] = useState<ProgresImport | null>(null);
  const [message, setMessage] = useState("");
  const [progresDl, setProgresDl] = useState<ProgresTelechargement | null>(null);
  // Le modèle choisi par l'utilisateur : c'est celui que le moteur cherchera.
  const modeleChoisi = useSession((s) => s.model);

  const telecharger = async () => {
    setEtat("ecriture");
    setProgresDl(null);
    setMessage("téléchargement dans la mémoire de l'appli (aucun autre outil)…");
    try {
      const resultat = await telechargerModeleParFetch(modeleChoisi, setProgresDl);
      setEtat("ok");
      setMessage(
        `modèle « ${modeleGguf(modeleChoisi).court} » en place (${tailleLisible(resultat.octets)}). ` +
          "Renvoie ta demande : le moteur le chargera.",
      );
    } catch (e) {
      setEtat("erreur");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const traiter = async (fichier: File) => {
    setEtat("ecriture");
    setProgres(null);
    setMessage(`fichier choisi : ${fichier.name} (${tailleLisible(fichier.size)}) — écriture en cours…`);
    try {
      // Le modèle est reconnu par sa TAILLE : c'est la seule correspondance
      // fiable quand le fichier téléchargé porte un autre nom.
      const modele = MODELES_GGUF.find((m) => tailleAcceptable(fichier.size, m.octets));
      if (!modele) {
        const attendues = MODELES_GGUF.map((m) => `${m.court} = ${tailleLisible(m.octets)}`).join(", ");
        throw new Error(
          `ce fichier fait ${tailleLisible(fichier.size)} : il ne correspond à aucun modèle ` +
            `attendu (${attendues}). Taille à 2 % près, téléchargement complet exigé.`,
        );
      }
      const resultat = await importerModeleDepuisFichier(fichier, modele.id, setProgres);
      setEtat("ok");
      setMessage(
        `modèle « ${modele.court} » en place (${tailleLisible(resultat.octets)}). ` +
          "Renvoie ta demande : le moteur le chargera.",
      );
    } catch (e) {
      setEtat("erreur");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mb-2 rounded border border-white/15 bg-white/5 px-2 py-1.5 font-sans">
      <p className="text-[11px] text-white/75">
        <span className="font-semibold">Le modèle n&apos;est pas dans l&apos;appli ?</span> Télécharge-le
        avec Chrome, puis importe-le ici — l&apos;appli le copie dans sa mémoire interne, sous le nom
        exact que le moteur cherche. Aucun réseau n&apos;est utilisé.
      </p>
      <div className="mt-1 flex items-center gap-2">
        <input
          ref={champ}
          type="file"
          accept="*/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void traiter(f);
            // On vide la valeur : réimporter le MÊME fichier doit redéclencher.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={etat === "ecriture"}
          onClick={() => champ.current?.click()}
          className="rounded border border-white/25 bg-white/10 px-2 py-1 text-[11px] text-white/90 disabled:opacity-50"
        >
          {etat === "ecriture" ? "écriture…" : "importer le fichier du modèle"}
        </button>
        <span className="text-[10px] text-white/60">{tailleLisible(modeleGguf(modeleChoisi).octets)} attendus</span>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          disabled={etat === "ecriture"}
          onClick={() => void telecharger()}
          className="rounded border border-white/25 bg-white/10 px-2 py-1 text-[11px] text-white/90 disabled:opacity-50"
        >
          télécharger ici ({tailleLisible(modeleGguf(modeleChoisi).octets)})
        </button>
        <span className="text-[10px] text-white/60">
          sans Chrome, sans le téléchargeur cassé — la WebView télécharge et écrit dans l&apos;appli
        </span>
      </div>

      {progresDl && (
        <p className="mt-1 font-mono text-[10px] text-white/70">
          {tailleLisible(progresDl.octetsRecus)} / {tailleLisible(progresDl.octetsTotal)} —{" "}
          {Math.round((progresDl.octetsRecus / progresDl.octetsTotal) * 100)} %
        </p>
      )}

      {progres && (
        <p className="mt-1 font-mono text-[10px] text-white/70">
          {tailleLisible(progres.octetsEcrits)} / {tailleLisible(progres.octetsTotal)} —{" "}
          {Math.round((progres.octetsEcrits / progres.octetsTotal) * 100)} % ({progres.morceaux} morceaux)
        </p>
      )}

      {message && (
        <p
          className={`mt-1 text-[11px] ${
            etat === "erreur" ? "text-red-300" : etat === "ok" ? "text-emerald-300" : "text-white/70"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
