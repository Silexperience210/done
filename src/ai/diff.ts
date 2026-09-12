/**
 * DIFF LIGNE À LIGNE, MAISON — ce qu'une correction a changé entre deux versions
 * d'une même app (P7 du brainstorm).
 *
 * Pourquoi maison et pas une dépendance : l'interface et llama.cpp se partagent
 * les mêmes cœurs ; on veut soixante lignes lisibles, pas une bibliothèque. Un
 * LCS (plus longue sous-suite commune) sur les lignes suffit : les apps font
 * quelques dizaines à quelques centaines de lignes, la table n×m tient sans
 * peine. Au-delà d'une borne (`MAX_CELLULES`), on renonce à l'optimal pour un
 * diff « préfixe commun + suffixe commun + tout le milieu remplacé » — jamais un
 * blocage de l'interface pour un fichier hors gabarit.
 */

export type TypeLigne = "=" | "+" | "-";

export type LigneDiff = {
  type: TypeLigne;
  texte: string;
  /** Numéro de ligne dans la version AVANT (`null` pour une ligne ajoutée). */
  a: number | null;
  /** Numéro de ligne dans la version APRÈS (`null` pour une ligne supprimée). */
  b: number | null;
};

/** Au-delà, la table LCS coûterait trop cher sur un téléphone : repli simple. */
export const MAX_CELLULES = 4_000_000;

function lignes(texte: string): string[] {
  const l = texte.split("\n");
  // Un texte finissant par « \n » produit une dernière ligne vide fantôme.
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return l;
}

/** Le diff : lignes conservées, ajoutées, supprimées, dans l'ordre de lecture. */
export function diffLignes(avant: string, apres: string): LigneDiff[] {
  const A = lignes(avant);
  const B = lignes(apres);

  // Préfixe et suffixe communs : gratuits, et ils réduisent la table.
  let debut = 0;
  while (debut < A.length && debut < B.length && A[debut] === B[debut]) debut++;
  let finA = A.length;
  let finB = B.length;
  while (finA > debut && finB > debut && A[finA - 1] === B[finB - 1]) {
    finA--;
    finB--;
  }

  const resultat: LigneDiff[] = [];
  for (let i = 0; i < debut; i++) resultat.push({ type: "=", texte: A[i], a: i + 1, b: i + 1 });

  const n = finA - debut;
  const m = finB - debut;
  if (n > 0 && m > 0 && n * m <= MAX_CELLULES) {
    // Table LCS classique : L[i][j] = longueur de la LCS de A[debut+i..] et B[debut+j..].
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i][j] = A[debut + i] === B[debut + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[debut + i] === B[debut + j]) {
        resultat.push({ type: "=", texte: A[debut + i], a: debut + i + 1, b: debut + j + 1 });
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) {
        resultat.push({ type: "-", texte: A[debut + i], a: debut + i + 1, b: null });
        i++;
      } else {
        resultat.push({ type: "+", texte: B[debut + j], a: null, b: debut + j + 1 });
        j++;
      }
    }
    for (; i < n; i++) resultat.push({ type: "-", texte: A[debut + i], a: debut + i + 1, b: null });
    for (; j < m; j++) resultat.push({ type: "+", texte: B[debut + j], a: null, b: debut + j + 1 });
  } else {
    // Repli (l'un des côtés est vide, ou la table serait trop grande) : tout le
    // milieu est remplacé. Moins fin, toujours exact.
    for (let i = debut; i < finA; i++) resultat.push({ type: "-", texte: A[i], a: i + 1, b: null });
    for (let j = debut; j < finB; j++) resultat.push({ type: "+", texte: B[j], a: null, b: j + 1 });
  }

  for (let k = 0; finA + k < A.length; k++) {
    resultat.push({ type: "=", texte: A[finA + k], a: finA + k + 1, b: finB + k + 1 });
  }
  return resultat;
}

/** Compte des lignes ajoutées / supprimées / inchangées : le résumé « +12 −3 ». */
export function resumeDiff(d: LigneDiff[]): { ajoutees: number; supprimees: number; inchangees: number } {
  let ajoutees = 0;
  let supprimees = 0;
  let inchangees = 0;
  for (const l of d) {
    if (l.type === "+") ajoutees++;
    else if (l.type === "-") supprimees++;
    else inchangees++;
  }
  return { ajoutees, supprimees, inchangees };
}
