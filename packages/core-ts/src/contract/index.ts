/**
 * Frozen interface of the Morrow Vault Contract: method signatures, JSON shapes, event kinds and
 * error codes, plus an in-memory mock that every lane can build against.
 *
 * Change rule: this module is the contract between the three build lanes (contract, services,
 * web). Change it only through a pull request that all three lanes acknowledge, and change the
 * Rust contract in the same pull request. Event kinds and error codes are append-only.
 */
export * from "./client.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./mock.js";
export * from "./policy.js";
export * from "./signet-policy.js";
export type * from "./types.js";
