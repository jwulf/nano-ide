// Runtime detection: pick the Node or Deno host at load time. Importing both adapter
// modules is safe — neither touches its runtime's globals at module top level.

import type { HostContext } from "../core/host.ts";
import { createNodeHost } from "./node.ts";
import { createDenoHost } from "./deno.ts";

/** True when running under Deno. */
export function isDeno(): boolean {
  const g = globalThis as { Deno?: { version?: unknown } };
  return typeof g.Deno !== "undefined" && typeof g.Deno.version !== "undefined";
}

export interface SelectHostOptions {
  cwd?: string;
  log?: HostContext["log"];
  /** Dev-only import-cache-busting nonce; forwarded to the chosen adapter. */
  importNonce?: string;
}

/** Select and construct the host for the current runtime. */
export function selectHost(opts: SelectHostOptions = {}): HostContext {
  return isDeno() ? createDenoHost(opts) : createNodeHost(opts);
}
