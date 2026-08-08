import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emitDomainModelJson,
  resolveShapes,
  type ShapeDecl,
} from "./shapes.ts";
import type { DomainTypeRegistry, SourceSchema } from "./domain.ts";

// The fuse + its drift guards, ported byte-for-byte from the console's `resolveShapes` /
// `emitDomainModelJson` tests (server domain_types_test.ts) — the toolkit is now the single source
// of truth for the IDE's shape fuse (host dry-out nano-bpm#576), so these lock the same behaviour.

test("emitDomainModelJson fuses tables, manifest types, shapes, and metadata", () => {
  const json = emitDomainModelJson({
    sources: [
      {
        source: "app",
        tables: [
          {
            name: "orders",
            columns: [{ name: "id", type: "INTEGER", notNull: true, primaryKey: true }],
            indexes: [],
            foreignKeys: [],
          },
        ],
      },
    ],
    default: "app",
    manifestTypes: { Order: { fields: { item: { type: "string" } } } },
    shapes: [
      {
        decl: { id: "ApprovedOrder", process: "orders", ops: [] },
        def: { fields: { item: { type: "string" }, approved: { type: "boolean" } } },
      },
    ],
    meta: [{ process: "orders", key: "classification", value: "internal" }],
    diagnostics: [],
  });
  const model = JSON.parse(json);
  assert.equal(model.version, 1);
  assert.equal(model.default, "app");
  assert.equal(typeof model.inputsHash, "string");
  assert.equal(model.inputsHash.length > 0, true);
  const byId = new Map<string, { kind: string; provenance: string }>(
    model.entities.map((e: { id: string; kind: string; provenance: string }) => [e.id, e]),
  );
  assert.equal(byId.get("app.orders")?.kind, "table");
  assert.equal(byId.get("app.orders")?.provenance, "db:app.orders");
  assert.equal(byId.get("Order")?.kind, "type");
  assert.equal(byId.get("Order")?.provenance, "manifest:Order");
  assert.equal(byId.get("ApprovedOrder")?.kind, "shape");
  assert.equal(byId.get("ApprovedOrder")?.provenance, "model:orders");
  assert.deepEqual(model.meta, [{ process: "orders", key: "classification", value: "internal" }]);
});

test("emitDomainModelJson inputsHash is stable across calls and shifts on any change", () => {
  const base = {
    sources: [],
    manifestTypes: { Order: { fields: { item: { type: "string" } } } },
    shapes: [],
    meta: [{ key: "owner", value: "sre" }],
    diagnostics: [],
  };
  const a = JSON.parse(emitDomainModelJson({ ...base }));
  const b = JSON.parse(emitDomainModelJson({ ...base }));
  assert.equal(a.inputsHash, b.inputsHash); // deterministic
  const changed = JSON.parse(
    emitDomainModelJson({ ...base, meta: [{ key: "owner", value: "ops" }] }),
  );
  assert.equal(changed.inputsHash !== a.inputsHash, true); // staleness detectable
});

test("resolveShapes reifies an all-extend shape into a flat domain type", () => {
  const shapes: ShapeDecl[] = [
    {
      id: "PrReviewRoundIn",
      name: "PR review round — input",
      ops: [
        { op: "extend", name: "prUrl", type: "string" },
        { op: "extend", name: "prNumber", type: "integer" },
        { op: "extend", name: "answer", type: "string", optional: true },
        { op: "extend", name: "labels", type: "string", list: true },
      ],
    },
  ];
  const { types, diagnostics } = resolveShapes(shapes, {}, []);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(types.PrReviewRoundIn, {
    name: "PR review round — input",
    fields: {
      prUrl: { type: "string" },
      prNumber: { type: "integer" },
      answer: { type: "string", optional: true },
      labels: { type: "string", list: true },
    },
  });
});

test("resolveShapes drift-guards a shape id colliding with a manifest type", () => {
  const shapes: ShapeDecl[] = [
    { id: "Order", ops: [{ op: "extend", name: "item", type: "string" }] },
  ];
  const manifest: DomainTypeRegistry = { Order: { fields: { item: { type: "string" } } } };
  const { types, diagnostics } = resolveShapes(shapes, manifest, []);
  assert.deepEqual(Object.keys(types), []); // shape omitted — no silent shadow
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, "same-id-collision");
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].shape, "Order");
});

test("resolveShapes treats a qualified-alias carry of the colliding leaf as composed", () => {
  // The shape id `orders` collides with the `app.orders` leaf, but it composes that same leaf via
  // its unambiguous `app.orders` alias. Since both ids point at the one entity, this is a legitimate
  // compose — not a same-id shadow — so no collision is raised.
  const sources: SourceSchema[] = [
    {
      source: "app",
      tables: [
        {
          name: "orders",
          columns: [{ name: "id", type: "INTEGER", notNull: true, primaryKey: true }],
          indexes: [],
          foreignKeys: [],
        },
      ],
    },
  ];
  const shapes: ShapeDecl[] = [{ id: "orders", ops: [{ op: "carry", ref: "app.orders" }] }];
  const { types, diagnostics } = resolveShapes(shapes, {}, sources);
  assert.equal(
    diagnostics.some((d) => d.kind === "same-id-collision"),
    false,
  );
  assert.ok(types.orders); // the shape resolves rather than being omitted
  assert.deepEqual(Object.keys(types.orders.fields), ["id"]);
});

test("resolveShapes rejects a duplicate shape id as a fuse-identity collision", () => {
  const shapes: ShapeDecl[] = [
    { id: "Dup", ops: [{ op: "extend", name: "a", type: "string" }] },
    { id: "Dup", ops: [{ op: "extend", name: "b", type: "string" }] },
  ];
  const { types, diagnostics } = resolveShapes(shapes, {}, []);
  assert.deepEqual(Object.keys(types), []); // both omitted
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, "duplicate-id");
  assert.equal(diagnostics[0].severity, "error");
});

test("resolveShapes flags an extend whose type is neither scalar nor a fused entity", () => {
  const shapes: ShapeDecl[] = [
    { id: "Bad", ops: [{ op: "extend", name: "ref", type: "NoSuchType" }] },
  ];
  const { types, diagnostics } = resolveShapes(shapes, {}, []);
  assert.deepEqual(Object.keys(types), []); // broken shape omitted
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, "unresolved-reference");
  assert.equal(diagnostics[0].severity, "error");
});

test("resolveShapes returns an empty resolution for no shapes", () => {
  const { types, diagnostics } = resolveShapes(
    [],
    { Order: { fields: { item: { type: "string" } } } },
    [],
  );
  assert.deepEqual(types, {});
  assert.deepEqual(diagnostics, []);
});
