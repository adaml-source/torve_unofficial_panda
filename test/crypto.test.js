/**
 * Tests for lib/crypto.js — symmetric encryption of provider credentials.
 * Run with: node --test test/crypto.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret } from "../src/lib/crypto.js";

test("encryptSecret returns v1 format", async () => {
  const ct = await encryptSecret("hello world");
  assert.ok(ct.startsWith("v1:"));
  assert.equal(ct.split(":").length, 4);
});

test("encrypt/decrypt round-trip", async () => {
  const plaintext = "super-secret-api-key-123";
  const ct = await encryptSecret(plaintext);
  const back = await decryptSecret(ct);
  assert.equal(back, plaintext);
});

test("empty input returns empty output", async () => {
  assert.equal(await encryptSecret(""), "");
  assert.equal(await encryptSecret(null), "");
  assert.equal(await decryptSecret(""), "");
});

test("decrypt rejects tampered ciphertext", async () => {
  const ct = await encryptSecret("secret");
  // Flip a byte in the ciphertext part
  const parts = ct.split(":");
  const ctBytes = Buffer.from(parts[2], "base64");
  ctBytes[0] ^= 0xff;
  parts[2] = ctBytes.toString("base64");
  const tampered = parts.join(":");
  await assert.rejects(() => decryptSecret(tampered));
});

test("decrypt rejects invalid format", async () => {
  await assert.rejects(() => decryptSecret("not-a-valid-ciphertext"));
  await assert.rejects(() => decryptSecret("v2:a:b:c"));
});

test("two encryptions of same plaintext produce different ciphertexts (IV randomness)", async () => {
  const ct1 = await encryptSecret("same");
  const ct2 = await encryptSecret("same");
  assert.notEqual(ct1, ct2);
  assert.equal(await decryptSecret(ct1), await decryptSecret(ct2));
});
