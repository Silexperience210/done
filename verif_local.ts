// Prouve, en exécutant le VRAI code du projet, quelles questions sont traitées
// en local et lesquelles dépendent de l'API xAI (donc échouent sans clé).
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
  "qui a inventé le bitcoin ?",
  "traduis 'bonjour' en anglais",
];

for (const q of questions) {
  const t = resolveLocalTurn(q);
  const ou =
    t.kind === "app"
      ? `LOCAL (mini-app : ${t.app.title})`
      : t.kind === "calc"
        ? `LOCAL (calcul : ${t.value})`
        : `API xAI requise → ${t.content.slice(0, 46)}…`;
  console.log(`  ${q.padEnd(38)} → ${ou}`);
}
