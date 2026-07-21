#!/usr/bin/env node
// Derive the C# IntelliSense block of nano-ide.ext.json from the Camunda C#
// SDK's own shipped XML documentation. We do NOT hand-author completions,
// signatures, or docs — the SDK is strongly typed and self-documenting, so this
// generator reads `Camunda.Orchestration.Sdk.xml` (co-shipped with the DLL in
// the NuGet cache) and emits the manifest's `intellisense` array.
//
// The console's pack-fed completion provider is a flat, global list (there is no
// in-browser C# language server to scope member completions to a receiver type),
// so we derive only the client *entry-point* surface — the handful of types a
// worker/app author actually types — keeping the suggestions relevant. All the
// text (summaries, parameter docs, signatures) is derived, never duplicated.
//
// Usage:  node scripts/gen-intellisense.mjs [--check]
//   --check  exit non-zero if the manifest is out of date (for CI), no write.
//
// The SDK version is read from the starter template's csproj. Override the
// NuGet cache root with NUGET_PACKAGES; otherwise ~/.nuget/packages is used.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(HERE, "..");
const MANIFEST = join(PACK_ROOT, "nano-ide.ext.json");
const CSPROJ = join(
  PACK_ROOT,
  "templates",
  "csharp-starter",
  "csharp-starter.csproj",
);
const SDK_PKG = "camunda.orchestration.sdk";

// Entry-point types a worker/app author types directly. Members of these are
// surfaced as global completions; every other SDK type stays out of the flat
// list (it would only add noise without type-scoped completion).
const ENTRY_TYPES = new Set([
  "CamundaClient",
  "CamundaOptions",
  "JobWorkerConfig",
  "ActivatedJob",
  "ProcessInstanceCreationInstruction",
  "ProcessInstanceCreationInstructionById",
  "ProcessInstanceCreationInstructionByKey",
  "ProcessDefinitionId",
  "ProcessDefinitionKey",
  "TopologyResponse",
  "ExtendedDeploymentResponse",
]);

// Low-level plumbing on CamundaClient that authors never call directly. Derived
// data is still 100% from the SDK; this only trims transport internals from the
// flat suggestion list.
const SKIP_MEMBERS = new Set([
  "SendAsync",
  "SendVoidAsync",
  "SendBinaryAsync",
  "SendMultipartAsync",
  "InvokeWithRetryAsync",
  "InjectDefaultTenantId",
  "Dispose",
  "DisposeAsync",
  "#cctor",
]);

function fail(msg) {
  console.error(`gen-intellisense: ${msg}`);
  process.exit(1);
}

function sdkVersion() {
  const csproj = readFileSync(CSPROJ, "utf8");
  const m = csproj.match(/Camunda\.Orchestration\.Sdk"\s+Version="([^"]+)"/i);
  if (!m) fail(`could not read SDK version from ${CSPROJ}`);
  return m[1];
}

function locateXml(version) {
  const root =
    process.env.NUGET_PACKAGES || join(homedir(), ".nuget", "packages");
  const pkgDir = join(root, SDK_PKG, version, "lib");
  if (!existsSync(pkgDir)) {
    fail(
      `SDK ${SDK_PKG} ${version} not found under ${pkgDir}. ` +
        `Run 'dotnet restore' on a C# project first (e.g. templates/csharp-starter).`,
    );
  }
  const tfms = readdirSync(pkgDir);
  const ordered = ["net8.0", ...tfms.filter((t) => t !== "net8.0")];
  for (const tfm of ordered) {
    const xml = join(pkgDir, tfm, "Camunda.Orchestration.Sdk.xml");
    if (existsSync(xml)) return xml;
  }
  fail(`no Camunda.Orchestration.Sdk.xml under ${pkgDir}`);
}

// --- XML doc parsing --------------------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Collapse a doc fragment to plain text: drop nested tags (code/para/see...),
// decode entities, normalise whitespace.
function cleanText(xml) {
  if (!xml) return "";
  let t = xml;
  t = t.replace(/<see\s+cref="[TMPF]:([^"]+)"\s*\/>/g, (_, id) =>
    id.split(".").pop(),
  );
  t = t.replace(/<see\s+langword="([^"]+)"\s*\/>/g, "$1");
  t = t.replace(/<paramref\s+name="([^"]+)"\s*\/>/g, "`$1`");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeEntities(t);
  return t.replace(/\s+/g, " ").trim();
}

// Split a generic/param type argument list on top-level commas (respecting the
// `{}` the XML uses for generic arguments).
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "(") depth++;
    else if (ch === "}" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const SYSTEM_ALIASES = {
  "System.String": "string",
  "System.Boolean": "bool",
  "System.Int32": "int",
  "System.Int64": "long",
  "System.Double": "double",
  "System.Object": "object",
  "System.Void": "void",
  "System.Threading.CancellationToken": "CancellationToken",
  "System.Threading.Tasks.Task": "Task",
  "System.TimeSpan": "TimeSpan",
};

// Turn a fully-qualified doc type (possibly generic `Name{args}`, array `[]`,
// or nullable) into a readable C# type name.
function simplifyType(fq) {
  let t = fq.trim();
  let suffix = "";
  const arr = t.match(/(\[\])+$/);
  if (arr) {
    suffix = arr[0];
    t = t.slice(0, -suffix.length);
  }
  const gi = t.indexOf("{");
  if (gi >= 0 && t.endsWith("}")) {
    const base = t.slice(0, gi);
    const args = splitTop(t.slice(gi + 1, -1)).map(simplifyType);
    const baseShort = SYSTEM_ALIASES[base] || base.split(".").pop();
    if (baseShort === "Nullable" && args.length === 1) {
      return `${args[0]}?${suffix}`;
    }
    return `${baseShort}<${args.join(", ")}>${suffix}`;
  }
  const alias = SYSTEM_ALIASES[t];
  if (alias) return alias + suffix;
  return t.split(".").pop() + suffix;
}

// Parse a member `name` attribute into { kind, type, member, paramTypes }.
function parseMemberId(id) {
  const prefix = id[0]; // T,M,P,F,E
  let rest = id.slice(2);
  let paramTypes = [];
  const paren = rest.indexOf("(");
  if (paren >= 0) {
    const argStr = rest.slice(paren + 1, rest.lastIndexOf(")"));
    if (argStr) paramTypes = splitTop(argStr).map((s) => s.trim());
    rest = rest.slice(0, paren);
  }
  rest = rest.replace(/`+\d+/g, "");
  if (prefix === "T") {
    return { kind: "type", type: rest.split(".").pop(), member: null, paramTypes };
  }
  const parts = rest.split(".");
  const member = parts.pop();
  const type = parts.pop();
  return { kind: prefix, type, member, paramTypes };
}

function parseMembers(xmlText) {
  const re = /<member name="([^"]+)">([\s\S]*?)<\/member>/g;
  const members = [];
  let m;
  while ((m = re.exec(xmlText))) {
    const [, id, body] = m;
    const summaryM = body.match(/<summary>([\s\S]*?)<\/summary>/);
    const summary = cleanText(summaryM ? summaryM[1] : "");
    const params = [];
    const preg = /<param name="([^"]+)">([\s\S]*?)<\/param>/g;
    let pm;
    while ((pm = preg.exec(body))) {
      params.push({ name: pm[1], doc: cleanText(pm[2]) });
    }
    const returnsM = body.match(/<returns>([\s\S]*?)<\/returns>/);
    const returns = cleanText(returnsM ? returnsM[1] : "");
    members.push({ id, summary, params, returns, ...parseMemberId(id) });
  }
  return members;
}

// --- Emit our schema --------------------------------------------------------

function lcFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function build(members) {
  const completions = [];
  const hoversBySymbol = new Map();
  const signatures = [];
  const seenCompletion = new Set();

  const addHover = (symbol, contents) => {
    if (!symbol || !contents) return;
    const prev = hoversBySymbol.get(symbol);
    if (prev && prev.includes(contents)) return;
    hoversBySymbol.set(symbol, prev ? `${prev}\n\n---\n\n${contents}` : contents);
  };

  const addCompletion = (item) => {
    const key = `${item.kind}:${item.label}`;
    if (seenCompletion.has(key)) return;
    seenCompletion.add(key);
    completions.push(item);
  };

  for (const mem of members) {
    if (mem.kind !== "type") continue;
    if (!ENTRY_TYPES.has(mem.type)) continue;
    if (mem.summary) {
      addCompletion({
        label: mem.type,
        kind: "class",
        detail: "Camunda.Orchestration.Sdk",
        documentation: mem.summary,
      });
      addHover(
        mem.type,
        `**\`class ${mem.type}\`** — Camunda.Orchestration.Sdk\n\n${mem.summary}`,
      );
    }
  }

  for (const mem of members) {
    if (mem.kind === "type") continue;
    if (!ENTRY_TYPES.has(mem.type)) continue;
    if (SKIP_MEMBERS.has(mem.member)) continue;
    if (mem.member.startsWith("get_") || mem.member.startsWith("set_")) continue;

    if (mem.kind === "M") {
      const isCtor = mem.member === "#ctor";
      const label = isCtor ? mem.type : mem.member;
      const paramNames = mem.params.map((p) => p.name);
      const paramTypes = mem.paramTypes.map(simplifyType);
      // With a documented name → "Type name"; otherwise just the type (avoid a
      // "Type Type" stutter when the SDK didn't name the parameter).
      const argLabels = paramTypes.map((t, i) =>
        paramNames[i] ? `${t} ${paramNames[i]}` : t,
      );
      const placeholders = paramTypes.map(
        (t, i) => paramNames[i] || lcFirst(t.replace(/[<>[\]?,\s]/g, "")),
      );
      const snippetArgs = placeholders
        .map((n, i) => `\${${i + 1}:${n}}`)
        .join(", ");
      const call = isCtor ? `new ${mem.type}` : mem.member;
      const insertText = `${call}(${snippetArgs})`;
      const sigLabel = `${call}(${argLabels.join(", ")})`;

      if (mem.summary || mem.returns) {
        addCompletion({
          label,
          kind: isCtor ? "constructor" : "method",
          insertText,
          snippet: true,
          detail: sigLabel,
          documentation: mem.summary || undefined,
        });
      }

      const hoverBody =
        `**\`${sigLabel}\`**` +
        (mem.summary ? `\n\n${mem.summary}` : "") +
        (mem.returns ? `\n\n*Returns:* ${mem.returns}` : "");
      addHover(label, hoverBody);

      if (argLabels.length) {
        signatures.push({
          trigger: label,
          label: sigLabel,
          documentation: mem.summary || undefined,
          parameters: argLabels.map((l, i) => ({
            label: l,
            documentation: mem.params[i]?.doc || undefined,
          })),
        });
      }
    } else if (mem.kind === "P" || mem.kind === "F") {
      if (!mem.summary) continue;
      addCompletion({
        label: mem.member,
        kind: mem.kind === "P" ? "property" : "field",
        detail: `${mem.type}.${mem.member}`,
        documentation: mem.summary,
      });
      addHover(mem.member, `**\`${mem.type}.${mem.member}\`**\n\n${mem.summary}`);
    }
  }

  const hovers = [...hoversBySymbol.entries()].map(([symbol, contents]) => ({
    symbol,
    contents,
  }));

  completions.sort(
    (a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind),
  );
  hovers.sort((a, b) => a.symbol.localeCompare(b.symbol));
  signatures.sort(
    (a, b) => a.trigger.localeCompare(b.trigger) || a.label.localeCompare(b.label),
  );

  return {
    monacoLang: "csharp",
    triggerCharacters: ["."],
    completions,
    hovers,
    signatures,
  };
}

// --- Drive ------------------------------------------------------------------

function stripUndefined(v) {
  return JSON.parse(JSON.stringify(v));
}

function main() {
  const check = process.argv.includes("--check");
  const version = sdkVersion();
  const xmlPath = locateXml(version);
  const xmlText = readFileSync(xmlPath, "utf8");
  const members = parseMembers(xmlText);
  const block = stripUndefined(build(members));

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  manifest.intellisense = [block];
  const out = JSON.stringify(manifest, null, 2) + "\n";

  if (check) {
    const current = readFileSync(MANIFEST, "utf8");
    if (current !== out) {
      fail(
        "nano-ide.ext.json intellisense is stale. Run 'npm run gen:intellisense' and commit.",
      );
    }
    console.log(
      `gen-intellisense: up to date (SDK ${version}, ${block.completions.length} completions).`,
    );
    return;
  }

  writeFileSync(MANIFEST, out);
  console.log(
    `gen-intellisense: wrote ${block.completions.length} completions, ` +
      `${block.hovers.length} hovers, ${block.signatures.length} signatures ` +
      `from SDK ${version} (${xmlPath}).`,
  );
}

main();
