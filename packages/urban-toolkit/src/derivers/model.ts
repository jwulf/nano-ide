// Deriver: code-first flow → BPMN model. A flow authored as data (a `.flow.json`, or built by a
// code DSL that emits this shape) is turned into a BPMN+DI document. Code is the source of
// truth; the .bpmn is a generated artifact (never hand-edited), which is why it lands under the
// generated dir and is covered by the `urban gen --check` drift gate.

import type { DerivedArtifact, Deriver } from "../artifact.ts";
import { GENERATED_DIR } from "../artifact.ts";
import { flowToBpmn, type CodeFlow } from "../bpmn.ts";

export function deriveModelFromFlow(flow: CodeFlow): DerivedArtifact[] {
  const xml = flowToBpmn(flow);
  return [{ path: `${GENERATED_DIR}/processes/${flow.id}.bpmn`, content: xml }];
}

export const modelDeriver: Deriver<CodeFlow> = {
  id: "code->model",
  describe: "Derive a BPMN+DI process model from a code-first flow definition.",
  derive: deriveModelFromFlow,
};

export type { CodeFlow, CodeFlowStep } from "../bpmn.ts";
