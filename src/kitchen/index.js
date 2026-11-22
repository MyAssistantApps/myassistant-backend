/**
 * KITCHEN — the pantry, kept by voice (pantry_update). Wiring:
 *
 *   kitchen.registerKitchenTools(registry);            // in registerBuiltins()
 *   ...kitchen.USER_TABLES                             // privacy export / erase
 *
 * Tables are created lazily on first use; migrate() may also be awaited at
 * boot.
 */
const { registerKitchenTools } = require("./tools");
const { migrate } = require("./store");

const USER_TABLES = [
  ["kitchen_pantry", "user_id"],
  ["kitchen_recipes", "user_id"],
  ["kitchen_plans", "user_id"],
];

module.exports = { registerKitchenTools, migrate, USER_TABLES };
