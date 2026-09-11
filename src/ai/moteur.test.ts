/**
 * Tests de la sélection de moteur. Aucun navigateur, aucun modèle : la décision
 * est une fonction pure, donc elle se vérifie.
 *
 * Enjeu réel : ne JAMAIS retomber sur WebGPU dans l'APK (plafond mémoire), et ne
 * jamais tenter le natif dans un navigateur (le plugin n'existe pas).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capacitesReelles, choisirMoteur, detecterCapacites } from "./moteur.ts";

test("le natif gagne dès qu'on est dans l'appli empaquetée", () => {
  assert.equal(choisirMoteur({ applicationNative: true, webgpu: true }), "natif");
});

test("le natif gagne même si le navigateur prétend avoir un GPU", () => {
  // C'est exactement le cas de l'APK : WebGPU peut exister dans la WebView, mais
  // il reste plafonné — llama.cpp doit primer.
  assert.equal(choisirMoteur({ applicationNative: true, webgpu: false }), "natif");
});

test("sans application native, on reste sur WebGPU", () => {
  assert.equal(choisirMoteur({ applicationNative: false, webgpu: true }), "webgpu");
});

test("Capacitor est détecté par sa présence, pas par sa véracité", () => {
  assert.equal(detecterCapacites({ capacitor: {} }).applicationNative, true);
  assert.equal(detecterCapacites({ capacitor: undefined }).applicationNative, false);
});

test("WebGPU n'est annoncé que si l'API GPU est là", () => {
  assert.equal(detecterCapacites({ gpu: {} }).webgpu, true);
  assert.equal(detecterCapacites({ gpu: null }).webgpu, false);
  assert.equal(detecterCapacites({}).webgpu, false);
});

test("dans cet environnement de test, aucun moteur natif n'est annoncé", () => {
  // Node n'a pas Capacitor : la détection réelle doit rester sobre et ne pas
  // inventer une application native.
  assert.equal(capacitesReelles().applicationNative, false);
});
