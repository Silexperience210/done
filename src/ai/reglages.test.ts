/**
 * Vérification des RÉGLAGES DU MOTEUR, hors téléphone.
 *
 * POURQUOI CE TEST EXISTE : le contexte est le réglage qui décide si un gros
 * modèle TIENT en mémoire. Se tromper d'un facteur 2 dans le calcul du cache KV,
 * c'est promettre 400 Mo et en consommer 800 — et l'utilisateur découvre l'erreur
 * par une application tuée par le système, sans explication. Les valeurs testées
 * ici sont calculées à partir des paramètres RÉELS des trois GGUF
 * (`block_count`, `attention.head_count_kv`, dimension de tête).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  contexteValide,
  ecrireReglages,
  lireReglages,
  memoireKVOctets,
  memoireTotaleOctets,
  normaliserReglages,
  REGLAGES_DEFAUT,
} from "./reglages.ts";
import { modeleGguf } from "./moteurNatif.ts";

test("le cache KV suit n_ctx × couches × têtes KV × dimension × 2 × 2 (f16)", () => {
  // 0,5B : 24 couches, 2 têtes KV, 64 par tête → 4096 jetons ≈ 48 Mo.
  assert.equal(memoireKVOctets("coder05", 4096), 4096 * 24 * 2 * 64 * 2 * 2);
  assert.equal(memoireKVOctets("coder05", 4096), 50_331_648);
  // 1,5B : 28 couches, 2 têtes KV, 128 → ≈ 112 Mo.
  assert.equal(memoireKVOctets("coder15", 4096), 117_440_512);
  // 30B-A3B : 48 couches, 4 têtes KV, 128 → ≈ 384 Mo. C'est LE chiffre qui
  // compte : quatre fois le 1,5B pour la même longueur de contexte.
  assert.equal(memoireKVOctets("coder3b", 4096), 402_653_184);
});

test("doubler le contexte double le cache KV, et le poids du modèle ne bouge pas", () => {
  assert.equal(memoireKVOctets("coder3b", 8192), 2 * memoireKVOctets("coder3b", 4096));
  assert.equal(memoireKVOctets("coder3b", 2048), memoireKVOctets("coder3b", 4096) / 2);
  const poids = modeleGguf("coder3b").octets;
  assert.equal(memoireTotaleOctets("coder3b", 4096), poids + memoireKVOctets("coder3b", 4096));
  // 8,01 Go de poids + 0,38 Go de KV ≈ 8,4 Go annoncés à l'écran.
  assert.equal(memoireTotaleOctets("coder3b", 4096), 8_407_866_528);
});

test("le contexte est ramené à une valeur proposée, sans dépasser le maximum du modèle", () => {
  assert.equal(contexteValide(4096, "coder3b"), 4096, "valeur proposée : gardée");
  assert.equal(contexteValide(262144, "coder3b"), 32768, "au-delà : on plafonne aux valeurs proposées");
  assert.equal(contexteValide(3000, "coder3b"), 2048, "valeur intermédiaire : la plus proche en dessous");
  assert.equal(contexteValide(1000, "coder05"), 2048, "trop petit : la plus petite proposée");
  assert.equal(contexteValide(99999, "coder05"), 32768);
});

test("des réglages corrompus ne cassent RIEN : on retombe sur les défauts", () => {
  // Ce que le stockage peut rendre après une version précédente, un JSON à
  // moitié écrit, ou une valeur tapée à la main.
  assert.deepEqual(normaliserReglages(null, "coder05"), REGLAGES_DEFAUT);
  assert.deepEqual(normaliserReglages("n'importe quoi", "coder05"), REGLAGES_DEFAUT);
  assert.deepEqual(normaliserReglages({ nCtx: Number.NaN }, "coder05"), REGLAGES_DEFAUT);
  assert.deepEqual(normaliserReglages({ nCtx: -5, nBatch: 0, nThreads: 99 }, "coder05"), {
    nCtx: 2048,
    nBatch: REGLAGES_DEFAUT.nBatch,
    nThreads: 0,
  });
  // Un contexte énorme pour le modèle : plafonné, jamais refusé.
  assert.equal(normaliserReglages({ nCtx: 262144 }, "coder15").nCtx, 32768);
});

test("le lot ne peut pas dépasser le contexte", () => {
  const r = normaliserReglages({ nCtx: 2048, nBatch: 1024 }, "coder05");
  assert.ok(r.nBatch <= r.nCtx);
});

test("lire/écrire les réglages, avec un stockage qui peut être cassé", () => {
  const memoire = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => memoire.get(k) ?? null,
    setItem: (k: string, v: string) => void memoire.set(k, v),
  };
  try {
    assert.deepEqual(lireReglages("coder05"), REGLAGES_DEFAUT, "rien d'enregistré : défauts");
    const choisis = { nCtx: 2048, nBatch: 256, nThreads: 4 };
    ecrireReglages(choisis);
    assert.deepEqual(lireReglages("coder05"), choisis, "aller-retour fidèle");

    memoire.set("studio.reglages-moteur", "{ ceci n'est pas du JSON");
    assert.deepEqual(lireReglages("coder05"), REGLAGES_DEFAUT, "JSON cassé : défauts, pas d'exception");

    // Stockage qui REFUSE d'écrire : l'appli doit continuer à fonctionner.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("stockage indisponible");
      },
      setItem: () => {
        throw new Error("quota dépassé");
      },
    };
    assert.deepEqual(lireReglages("coder05"), REGLAGES_DEFAUT);
    ecrireReglages({ nCtx: 8192, nBatch: 512, nThreads: 0 }); // ne doit pas lever
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
