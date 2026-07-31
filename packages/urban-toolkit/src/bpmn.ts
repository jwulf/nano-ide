// A tiny, deterministic BPMN+DI generator for the code→model deriver. Given a linear code-first
// flow (a start, a sequence of service-task steps, an end), it emits a valid Camunda 8 BPMN
// document with auto-laid-out DI. This is the "code-first flow → model" direction of derivation:
// the model is generated from code, so the code is the source of truth and the .bpmn is an
// artifact (never hand-edited).

export interface CodeFlowStep {
  id: string;
  name?: string;
  /** Zeebe service-task type this step activates. */
  taskType: string;
}

export interface CodeFlow {
  id: string;
  name?: string;
  /** If set, the process starts on a message start event with this name; otherwise a plain start. */
  startMessage?: string;
  steps: CodeFlowStep[];
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Render a CodeFlow to a BPMN XML string with deterministic DI. */
export function flowToBpmn(flow: CodeFlow): string {
  if (!flow.id) throw new Error("flow.id is required");
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    throw new Error(`flow "${flow.id}" has no steps`);
  }
  const name = flow.name ?? flow.id;
  const gap = 64;

  // Node ids in visual order.
  const startId = "Start";
  const endId = "End";
  const nodeIds = [startId, ...flow.steps.map((s) => s.id), endId];

  // Layout on a single row; centre line y = 118.
  const boxes = new Map<string, Box>();
  let cursor = 160;
  boxes.set(startId, { x: cursor, y: 100, w: 36, h: 36 });
  cursor += 36 + gap;
  for (const s of flow.steps) {
    boxes.set(s.id, { x: cursor, y: 78, w: 100, h: 80 });
    cursor += 100 + gap;
  }
  boxes.set(endId, { x: cursor, y: 100, w: 36, h: 36 });

  // Sequence flows between consecutive nodes.
  const flows = nodeIds.slice(0, -1).map((src, i) => ({
    id: `Flow_${i}`,
    source: src,
    target: nodeIds[i + 1],
  }));

  const incoming = (nodeId: string): string[] =>
    flows.filter((f) => f.target === nodeId).map((f) => f.id);
  const outgoing = (nodeId: string): string[] =>
    flows.filter((f) => f.source === nodeId).map((f) => f.id);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
      'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" ' +
      'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" ' +
      'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" ' +
      `id="Definitions_${xmlEscape(flow.id)}" targetNamespace="http://bpmn.io/schema/bpmn">`,
  );

  if (flow.startMessage) {
    lines.push(`  <bpmn:message id="Message_${xmlEscape(flow.id)}" name="${xmlEscape(flow.startMessage)}" />`);
  }

  lines.push(`  <bpmn:process id="${xmlEscape(flow.id)}" name="${xmlEscape(name)}" isExecutable="true">`);

  // Start event.
  lines.push(`    <bpmn:startEvent id="${startId}">`);
  for (const o of outgoing(startId)) lines.push(`      <bpmn:outgoing>${o}</bpmn:outgoing>`);
  if (flow.startMessage) {
    lines.push(`      <bpmn:messageEventDefinition id="MsgDef_${xmlEscape(flow.id)}" messageRef="Message_${xmlEscape(flow.id)}" />`);
  }
  lines.push(`    </bpmn:startEvent>`);

  // Service tasks.
  for (const s of flow.steps) {
    lines.push(`    <bpmn:serviceTask id="${xmlEscape(s.id)}" name="${xmlEscape(s.name ?? s.id)}">`);
    lines.push(`      <bpmn:extensionElements>`);
    lines.push(`        <zeebe:taskDefinition type="${xmlEscape(s.taskType)}" />`);
    lines.push(`      </bpmn:extensionElements>`);
    for (const inc of incoming(s.id)) lines.push(`      <bpmn:incoming>${inc}</bpmn:incoming>`);
    for (const o of outgoing(s.id)) lines.push(`      <bpmn:outgoing>${o}</bpmn:outgoing>`);
    lines.push(`    </bpmn:serviceTask>`);
  }

  // End event.
  lines.push(`    <bpmn:endEvent id="${endId}">`);
  for (const inc of incoming(endId)) lines.push(`      <bpmn:incoming>${inc}</bpmn:incoming>`);
  lines.push(`    </bpmn:endEvent>`);

  // Sequence flows.
  for (const f of flows) {
    lines.push(`    <bpmn:sequenceFlow id="${f.id}" sourceRef="${xmlEscape(f.source)}" targetRef="${xmlEscape(f.target)}" />`);
  }
  lines.push(`  </bpmn:process>`);

  // DI.
  lines.push(`  <bpmndi:BPMNDiagram id="BPMNDiagram_${xmlEscape(flow.id)}">`);
  lines.push(`    <bpmndi:BPMNPlane id="BPMNPlane_${xmlEscape(flow.id)}" bpmnElement="${xmlEscape(flow.id)}">`);
  for (const nodeId of nodeIds) {
    const b = boxes.get(nodeId)!;
    lines.push(`      <bpmndi:BPMNShape id="${nodeId}_di" bpmnElement="${nodeId}">`);
    lines.push(`        <dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" />`);
    lines.push(`      </bpmndi:BPMNShape>`);
  }
  for (const f of flows) {
    const s = boxes.get(f.source)!;
    const t = boxes.get(f.target)!;
    const sx = s.x + s.w;
    const sy = s.y + s.h / 2;
    const tx = t.x;
    const ty = t.y + t.h / 2;
    lines.push(`      <bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">`);
    lines.push(`        <di:waypoint x="${sx}" y="${sy}" />`);
    lines.push(`        <di:waypoint x="${tx}" y="${ty}" />`);
    lines.push(`      </bpmndi:BPMNEdge>`);
  }
  lines.push(`    </bpmndi:BPMNPlane>`);
  lines.push(`  </bpmndi:BPMNDiagram>`);
  lines.push(`</bpmn:definitions>`);
  lines.push("");
  return lines.join("\n");
}
