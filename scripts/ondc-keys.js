#!/usr/bin/env node
/**
 * ONDC KEYS (2026-11-04) — `node scripts/ondc-keys.js`
 *
 * Makes the signing (Ed25519) and encryption (X25519) key pairs ONDC asks
 * for when registering, and a unique key id. Prints:
 *   - the lines for the server's .env (PRIVATE keys: keep them there only)
 *   - the PUBLIC keys to paste into the ONDC portal's registration form.
 */
const { randomUUID } = require("crypto");
const { generateKeys } = require("../src/ondc/crypto");

const k = generateKeys();
const ukId = randomUUID();
console.log("# --- for the server .env (never commit) ---");
console.log(`ONDC_UKID=${ukId}`);
console.log(`ONDC_SIGNING_PRIVATE_KEY=${k.signingPrivateKey}`);
console.log(`ONDC_SIGNING_PUBLIC_KEY=${k.signingPublicKey}`);
console.log(`ONDC_ENCRYPTION_PRIVATE_KEY=${k.encryptionPrivateKey}`);
console.log(`ONDC_ENCRYPTION_PUBLIC_KEY=${k.encryptionPublicKey}`);
console.log("");
console.log("# --- for the ONDC registration form (public) ---");
console.log(`unique_key_id:        ${ukId}`);
console.log(`signing_public_key:   ${k.signingPublicKey}`);
console.log(`encryption_public_key:${k.encryptionPublicKey}`);
