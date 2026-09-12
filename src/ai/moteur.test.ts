/**
 * Tests de la détection d'application native. Aucun navigateur, aucun modèle :
 * la décision est une fonction pure, donc elle se vérifie.
 *
 * Enjeu réel : le SEUL moteur d'inférence du projet est llama.cpp en natif. Il
 * ne faut donc tenter de le charger — et donc importer le plugin Capacitor — que
 * dans l'APK. Un navigateur qui présente un shim Capacitor répondant `false` ne
 * doit PAS être pris pour l'appli native.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detecterNative, estApplicationNative } from "./moteur.ts";

test("l'application native est reconnue quand Capacitor répond true", () => {
  assert.equal(detecterNative({ Capacitor: { isNativePlatform: () => true } }), true);
});

test("un shim Capacitor qui répond false n'est PAS l'application native", () => {
  // Cas du navigateur : le shim Capacitor peut exister et répondre false. On se
  // fie à sa VÉRACITÉ, pas à sa seule présence.
  assert.equal(detecterNative({ Capacitor: { isNativePlatform: () => false } }), false);
});

test("Capacitor absent ou incomplet → pas natif", () => {
  assert.equal(detecterNative({}), false);
  assert.equal(detecterNative({ Capacitor: {} }), false);
  assert.equal(detecterNative({ Capacitor: { isNativePlatform: "yes" as unknown as () => boolean } }), false);
});

test("dans cet environnement de test, aucune application native n'est annoncée", () => {
  // Node n'a pas Capacitor : la détection réelle doit rester sobre et ne pas
  // inventer une application native.
  assert.equal(estApplicationNative(), false);
});
