/**
 * DÉMARRE LA TRACE au lancement de l'appli (voir `src/ai/journal.ts`).
 *
 * POURQUOI CE COMPOSANT EXISTE, séparé du reste : l'utilisateur n'a QUE son
 * téléphone. Il ne peut pas lire `adb logcat`, donc tout ce qu'on écrit dans la
 * console est perdu pour lui. Ce qui sert, c'est un FICHIER texte qu'un
 * gestionnaire de fichiers ouvre. Il est créé ICI, à l'instant du démarrage, et
 * pas au premier chargement de modèle : c'est ce qui permet de vérifier que
 * l'écriture fonctionne AVANT d'avoir besoin du journal pour diagnostiquer un
 * blocage. Si le fichier n'existe pas, le problème est l'écriture — pas le
 * moteur.
 *
 * IL NE REND RIEN ET NE BLOQUE RIEN : monté dans `__root.tsx`, il lance la
 * recherche d'emplacement et se retire. Aucune erreur n'en remonte (l'écriture
 * d'une trace ne doit jamais empêcher l'appli de fonctionner), et hors
 * application native (page web) il ne fait RIEN : là-bas, il n'y a ni
 * `@capacitor/filesystem`, ni raison d'écrire un fichier.
 */

import { useEffect } from "react";
import { estApplicationNative } from "@/ai/moteur";

export function JournalDemarrage() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!estApplicationNative()) return;

    // Import DYNAMIQUE : `journal.ts` n'existe pour le bundle navigateur qu'au
    // moment où on le demande, et il n'importe `@capacitor/filesystem` qu'à
    // l'appel. Le build web reste donc intact.
    void (async () => {
      try {
        const { demarrerJournal, etatJournal } = await import("@/ai/journal");
        const etat = await demarrerJournal();
        if (etat.actif) {
          console.log(`[studio] trace : ${etat.chemin}${etat.cheminReel ? ` (${etat.cheminReel})` : ""}`);
          if (!etat.visible) {
            // L'emplacement retenu n'est PAS ouvrable par l'utilisateur : on le
            // dit tout de suite dans la console, parce que ça change ce qu'on
            // peut lui demander de faire d'un journal.
            console.warn("[studio] trace dans un emplacement non ouvrable depuis le téléphone");
          }
        } else {
          console.warn(
            "[studio] AUCUNE trace n'a pu être écrite. Emplacements refusés :",
            etatJournal().refus,
          );
        }
      } catch (e) {
        // Démarrage impossible : ce n'est pas une raison de gêner l'appli.
        console.warn("[studio] démarrage de la trace impossible :", e);
      }
    })();
  }, []);

  return null;
}
