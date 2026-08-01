// security — parse the manifest `security` block into a policy the runtime can consult
// (ADR 0028). Provider login (OIDC/password) is out of scope for this slice; what we
// materialize is the declarative role→action/surface/data rule set plus a `local` mode
// fallback, so hosts can enforce access consistently. Enforcement middleware can layer on
// this policy later.

import type { RuntimeContext } from "../context.ts";

export interface SecurityPolicy {
  readonly mode: string;
  readonly roles: string[];
  /** Roles allowed to reach a surface path (empty/undefined ⇒ open). */
  surfaceRoles(path: string): string[] | undefined;
  /** Roles allowed to perform an action key (supports `prefix/*` rules). */
  actionRoles(action: string): string[] | undefined;
  describe(): Record<string, unknown>;
}

function matchRule(rules: Record<string, string[]> | undefined, key: string): string[] | undefined {
  if (!rules) return undefined;
  if (rules[key]) return rules[key];
  // support "prefix/*" wildcard rules
  for (const [pat, roles] of Object.entries(rules)) {
    if (pat.endsWith("/*") && key.startsWith(pat.slice(0, -1))) return roles;
  }
  return undefined;
}

export function mountSecurity(ctx: RuntimeContext): SecurityPolicy {
  const sec = (ctx.manifest.security ?? {}) as {
    mode?: string;
    roles?: string[];
    rules?: {
      actions?: Record<string, string[]>;
      surfaces?: Record<string, string[]>;
      data?: Record<string, unknown>;
    };
  };
  const mode = sec.mode ?? "local";
  const roles = sec.roles ?? [];
  const surfaces = sec.rules?.surfaces;
  const actions = sec.rules?.actions;

  ctx.host.log("info", "security policy loaded", { mode, roles });

  return {
    mode,
    roles,
    surfaceRoles: (path) => matchRule(surfaces, path),
    actionRoles: (action) => matchRule(actions, action),
    describe: () => ({ mode, roles, surfaces: surfaces ?? {}, actions: actions ?? {} }),
  };
}
