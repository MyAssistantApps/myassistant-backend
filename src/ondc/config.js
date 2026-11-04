/**
 * ONDC SETTINGS (2026-11-04). Everything comes from the environment; with
 * any of the required ones missing the network is "not connected" and the
 * app says so — nothing is ever faked.
 *
 *   ONDC_ENV                 staging | preprod | prod        (default staging)
 *   ONDC_SUBSCRIBER_ID       our id on the network, e.g. myassistant.wishme.today
 *   ONDC_SUBSCRIBER_URL      where ONDC calls us back, e.g. https://myassistant.wishme.today/ondc
 *   ONDC_UKID                the unique key id registered with our keys
 *   ONDC_SIGNING_PRIVATE_KEY / ONDC_SIGNING_PUBLIC_KEY        (scripts/ondc-keys.js)
 *   ONDC_ENCRYPTION_PRIVATE_KEY / ONDC_ENCRYPTION_PUBLIC_KEY
 *   ONDC_GATEWAY_URL         the gateway our searches go to
 *   ONDC_REGISTRY_URL        the registry we look senders up in
 *   ONDC_REGISTRY_PUBLIC_KEY the registry's encryption key (on_subscribe)
 *   ONDC_VERIFY_CALLBACKS    "off" only while testing — callbacks are
 *                            otherwise checked against the sender's key
 */
const DEFAULTS = {
  staging: {
    gateway: "https://staging.gateway.proteantech.in/",
    registry: "https://staging.registry.ondc.org",
  },
  preprod: {
    gateway: "https://preprod.gateway.ondc.org/",
    registry: "https://preprod.registry.ondc.org/ondc",
  },
  prod: {
    gateway: "https://prod.gateway.ondc.org/",
    registry: "https://prod.registry.ondc.org",
  },
};

function cfg() {
  const env = ["staging", "preprod", "prod"].includes(process.env.ONDC_ENV)
    ? process.env.ONDC_ENV : "staging";
  const d = DEFAULTS[env];
  return {
    env,
    subscriberId: process.env.ONDC_SUBSCRIBER_ID || "",
    subscriberUrl: (process.env.ONDC_SUBSCRIBER_URL || "").replace(/\/+$/, ""),
    ukId: process.env.ONDC_UKID || "",
    signingPrivateKey: process.env.ONDC_SIGNING_PRIVATE_KEY || "",
    signingPublicKey: process.env.ONDC_SIGNING_PUBLIC_KEY || "",
    encryptionPrivateKey: process.env.ONDC_ENCRYPTION_PRIVATE_KEY || "",
    encryptionPublicKey: process.env.ONDC_ENCRYPTION_PUBLIC_KEY || "",
    gatewayUrl: process.env.ONDC_GATEWAY_URL || d.gateway,
    registryUrl: (process.env.ONDC_REGISTRY_URL || d.registry).replace(/\/+$/, ""),
    registryPublicKey: process.env.ONDC_REGISTRY_PUBLIC_KEY || "",
    verifyCallbacks: process.env.ONDC_VERIFY_CALLBACKS !== "off",
    country: "IND",
    coreVersion: "1.2.0",
  };
}

function configured() {
  const c = cfg();
  return Boolean(c.subscriberId && c.subscriberUrl && c.ukId && c.signingPrivateKey);
}

/** ONDC retail domains the app shops in. */
const DOMAINS = {
  grocery: "ONDC:RET10",
  food: "ONDC:RET11",
};

module.exports = { cfg, configured, DOMAINS };
