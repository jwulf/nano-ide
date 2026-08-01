// Minimal ambient types for `bpmn-auto-layout` (ships none of its own).
// `layoutProcess` adds diagram interchange (DI) to a BPMN XML string. The
// resolved shape has settled on `{ xml, warnings }` in 2.x (and >= 1.4); 1.3.x
// resolved to the laid-out XML string directly. We type the union and normalize
// at the call site (see `layout.ts`) so the SDK still works across that range.
declare module "bpmn-auto-layout" {
  export function layoutProcess(
    xml: string,
  ): Promise<string | { xml: string; warnings?: unknown[] }>;
}
