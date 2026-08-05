import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeContext } from "../context.ts";
import type { HostContext } from "../host.ts";
import type { AppManifest } from "../manifest.ts";
import { deployModels } from "./deploy.ts";
import { applyTemplates, resolveTemplates, type TemplateSource } from "./templates.ts";

const ROOT = "/app";

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

interface DeployedResource {
  name: string;
  content: string;
  contentType: string;
}

interface Harness {
  ctx: RuntimeContext;
  logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
  deployed: DeployedResource[];
}

/** A virtual-filesystem host over `files` (keyed by absolute path) plus a recording engine. */
function makeHarness(
  files: Record<string, string>,
  manifest: Partial<AppManifest>,
  templates?: TemplateSource,
): Harness {
  const logs: Harness["logs"] = [];
  const deployed: DeployedResource[] = [];
  const host: HostContext = {
    runtime: "node",
    log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) =>
      logs.push({ level, msg, fields }),
    exists: async (p: string) =>
      p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    readTextFile: async (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    listDir: async (dir: string) =>
      Object.keys(files)
        .filter((f) => dirname(f) === dir)
        .map((f) => f.slice(f.lastIndexOf("/") + 1)),
  } as unknown as HostContext;
  const engine = {
    deployResources: async (resources: DeployedResource[]) => {
      deployed.push(...resources);
      return { deployed: resources.length };
    },
  };
  const ctx = {
    root: ROOT,
    manifest: { schemaVersion: 1, id: "t", name: "T", ...manifest } as AppManifest,
    engine: engine as unknown as RuntimeContext["engine"],
    host,
    templates,
  } as unknown as RuntimeContext;
  return { ctx, logs, deployed };
}

// ── applyTemplates ─────────────────────────────────────────────────────────

test("applyTemplates substitutes a named placeholder", () => {
  const { content, unresolved } = applyTemplates("<a>{{greet}}</a>", "text/xml", {
    greet: "hello",
  });
  assert.equal(content, "<a>hello</a>");
  assert.deepEqual(unresolved, []);
});

test("applyTemplates tolerates inner whitespace in the placeholder", () => {
  const { content } = applyTemplates("{{  greet  }}", "text/xml", { greet: "hi" });
  assert.equal(content, "hi");
});

test("applyTemplates encodes newlines/tabs as XML character references (survives attr normalization)", () => {
  const { content } = applyTemplates('value="{{p}}"', "text/xml", {
    p: "line1\nline2\twith <b> & 'q'",
  });
  assert.equal(content, 'value="line1&#10;line2&#9;with &lt;b&gt; &amp; &apos;q&apos;"');
  // Critically, no literal newline/tab remains (those would collapse to spaces in an attribute).
  assert.ok(!/[\n\t]/.test(content));
});

test("applyTemplates escapes JSON-string content for .form resources", () => {
  const { content } = applyTemplates('{"q":"{{p}}"}', "application/json", {
    p: 'a\nb"c',
  });
  assert.equal(content, '{"q":"a\\nb\\"c"}');
  assert.deepEqual(JSON.parse(content), { q: 'a\nb"c' });
});

test("applyTemplates leaves unknown placeholders verbatim and reports them once", () => {
  const { content, unresolved } = applyTemplates("{{x}} {{y}} {{x}}", "text/xml", {});
  assert.equal(content, "{{x}} {{y}} {{x}}");
  assert.deepEqual(unresolved, ["x", "y"]);
});

test("applyTemplates is non-recursive: a template's own braces are not re-expanded", () => {
  const { content, unresolved } = applyTemplates("{{a}}", "text/xml", {
    a: "{{b}}",
    b: "SHOULD-NOT-APPEAR",
  });
  assert.equal(content, "{{b}}");
  assert.deepEqual(unresolved, []);
});

// ── resolveTemplates ─────────────────────────────────────────────────────────

test("resolveTemplates reads a glob source, keying by file stem", async () => {
  const { ctx } = makeHarness(
    { "/app/prompts/review.md": "REVIEW", "/app/prompts/fix-ci.md": "FIXCI" },
    {},
  );
  const map = await resolveTemplates(ctx.host, ROOT, [["prompts/*.md"]]);
  assert.deepEqual(map, { review: "REVIEW", "fix-ci": "FIXCI" });
});

test("resolveTemplates scans a bare directory entry", async () => {
  const { ctx } = makeHarness(
    { "/app/prompts/a.md": "A", "/app/prompts/b.md": "B" },
    {},
  );
  const map = await resolveTemplates(ctx.host, ROOT, [["prompts"]]);
  assert.deepEqual(map, { a: "A", b: "B" });
});

test("resolveTemplates resolves a literal file entry", async () => {
  const { ctx } = makeHarness({ "/app/prompts/one.md": "ONE" }, {});
  const map = await resolveTemplates(ctx.host, ROOT, [["prompts/one.md"]]);
  assert.deepEqual(map, { one: "ONE" });
});

test("resolveTemplates merges a programmatic map, letting later sources win", async () => {
  const { ctx } = makeHarness({ "/app/prompts/review.md": "FROM-FILE" }, {});
  const map = await resolveTemplates(ctx.host, ROOT, [
    ["prompts/*.md"],
    { review: "FROM-MAP", extra: "X" },
  ]);
  assert.deepEqual(map, { review: "FROM-MAP", extra: "X" });
});

// ── deployModels integration ─────────────────────────────────────────────────

test("deployModels substitutes manifest templates into deployed model content", async () => {
  const { ctx, deployed } = makeHarness(
    {
      "/app/processes/agent.bpmn": '<x value="{{review}}" />',
      "/app/prompts/review.md": "Do the review",
    },
    { models: { processes: ["processes/*.bpmn"], templates: ["prompts/*.md"] } },
  );
  const res = await deployModels(ctx);
  assert.equal(res.deployed, 1);
  assert.equal(deployed[0].name, "agent.bpmn");
  assert.equal(deployed[0].content, '<x value="Do the review" />');
});

test("deployModels lets the programmatic templates option win over the manifest", async () => {
  const { ctx, deployed } = makeHarness(
    {
      "/app/processes/agent.bpmn": '<x value="{{review}}" />',
      "/app/prompts/review.md": "FROM-MANIFEST",
    },
    { models: { processes: ["processes/*.bpmn"], templates: ["prompts/*.md"] } },
    { review: "FROM-OPTION" },
  );
  await deployModels(ctx);
  assert.equal(deployed[0].content, '<x value="FROM-OPTION" />');
});

test("deployModels warns on an unresolved placeholder but still deploys", async () => {
  const { ctx, deployed, logs } = makeHarness(
    {
      "/app/processes/agent.bpmn": '<x a="{{present}}" b="{{missing}}" />',
      "/app/prompts/present.md": "HERE",
    },
    { models: { processes: ["processes/*.bpmn"], templates: ["prompts/*.md"] } },
  );
  const res = await deployModels(ctx);
  assert.equal(res.deployed, 1);
  assert.equal(deployed[0].content, '<x a="HERE" b="{{missing}}" />');
  const warn = logs.find((l) => l.msg.includes("unresolved template placeholders"));
  assert.ok(warn, "expected an unresolved-placeholder warning");
  assert.deepEqual(warn?.fields?.unresolved, ["missing"]);
});

test("deployModels is a no-op on content when no templates are configured", async () => {
  const { ctx, deployed } = makeHarness(
    { "/app/processes/agent.bpmn": '<x value="{{review}}" />' },
    { models: { processes: ["processes/*.bpmn"] } },
  );
  await deployModels(ctx);
  // With no templates, placeholders are left untouched (no substitution pass runs).
  assert.equal(deployed[0].content, '<x value="{{review}}" />');
});
