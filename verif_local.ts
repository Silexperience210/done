// Prouve, en exécutant le VRAI code du projet, quelles demandes sont traitées
// en LOCAL et lesquelles passent par le modèle.
//
// `resolveLocalTurn` ne renvoie plus jamais de réponse pré-écrite : soit une
// fonctionnalité locale déterministe (mini-app écrite à la main, calcul
// réellement exécuté), soit `null` — et c'est alors au modèle local de
// répondre. Il n'existe plus de branche « texte de remplacement ».
import { resolveLocalTurn } from "./src/lib/local-apps";

const questions = [
  "ping pong",
  "fais-moi un snake",
  "des particules",
  "calcule 12*7",
  "2 puissance 10",
  "c'est quoi le streaming ?",
  "combien de RAM utilise le modèle ?",
  "Quelle est la capitale de la France ?",
  "explique-moi la photosynthèse",
  "écris un poème sur la mer",
];

for (const q of questions) {
  const t = resolveLocalTurn(q);
  const ou =
    t === null
      ? "modèle local requis"
      : t.kind === "app"
        ? `LOCAL (mini-app : ${t.app.title})`
        : `LOCAL (calcul : ${t.value})`;
  console.log(`  ${q.padEnd(38)} → ${ou}`);
}
