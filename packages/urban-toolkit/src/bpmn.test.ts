import { test } from "node:test";
import assert from "node:assert/strict";
import { flowToBpmn, type CodeFlow } from "./bpmn.ts";
import { deriveModelFromFlow } from "./derivers/model.ts";

const flow: CodeFlow = {
  id: "onboard",
  name: "Onboard user",
  startMessage: "onboard.requested",
  steps: [
    { id: "CreateAccount", name: "Create account", taskType: "onboard.create" },
    { id: "SendWelcome", name: "Send welcome", taskType: "onboard.welcome" },
  ],
};

test("flowToBpmn emits a well-formed, deterministic BPMN document", () => {
  const a = flowToBpmn(flow);
  const b = flowToBpmn(flow);
  assert.equal(a, b, "same flow ⇒ identical XML");
  assert.match(a, /<bpmn:process id="onboard" name="Onboard user" isExecutable="true">/);
  assert.match(a, /<bpmn:messageEventDefinition[^>]*messageRef="Message_onboard"/);
  assert.match(a, /<zeebe:taskDefinition type="onboard.create" \/>/);
  assert.match(a, /<zeebe:taskDefinition type="onboard.welcome" \/>/);
  // One DI shape per node (start + 2 tasks + end = 4) and edges (3).
  assert.equal((a.match(/<bpmndi:BPMNShape\b/g) ?? []).length, 4);
  assert.equal((a.match(/<bpmndi:BPMNEdge\b/g) ?? []).length, 3);
  assert.equal((a.match(/<bpmn:sequenceFlow\b/g) ?? []).length, 3);
});

test("flowToBpmn escapes XML-significant characters", () => {
  const a = flowToBpmn({ id: "p", name: 'A & B "x"', steps: [{ id: "S", taskType: "t" }] });
  assert.match(a, /name="A &amp; B &quot;x&quot;"/);
});

test("flowToBpmn rejects a flow with no steps", () => {
  assert.throws(() => flowToBpmn({ id: "empty", steps: [] }), /no steps/);
});

test("deriveModelFromFlow writes under the generated processes dir", () => {
  const arts = deriveModelFromFlow(flow);
  assert.equal(arts.length, 1);
  assert.equal(arts[0].path, "nano-generated/processes/onboard.bpmn");
});
