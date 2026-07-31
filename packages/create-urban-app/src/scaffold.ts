// The scaffolder core: materialize a runnable Urban app repo from the bundled template,
// substituting the app id/name. Pure codegen — no runtime logic. Uses node:fs/node:path,
// which both Node and Deno provide, so `npm create urban-app` and
// `deno run -A npm:create-urban-app` both work.

import { cp, mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScaffoldOptions {
  /** App name (human-readable). */
  name: string;
  /** Target directory (created if missing). */
  dir: string;
  /** App id slug. Default: derived from name. */
  id?: string;
  /** Preset: "full" (workers + surfaces + triggers) or "headless" (workers only). */
  preset?: "full" | "headless";
}

export interface ScaffoldResult {
  dir: string;
  id: string;
  files: string[];
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "urban-app";
}

function templateRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "template");
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(root);
  return out;
}

function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/__([A-Z_]+)__/g, (m, key) => vars[key] ?? m);
}

/** Rename a template filename: `_gitignore` → `.gitignore` (npm strips dotfiles from packs). */
function finalName(name: string): string {
  return name === "_gitignore" ? ".gitignore" : name;
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const id = opts.id ?? slugify(opts.name);
  const preset = opts.preset ?? "full";
  const headless = preset === "headless";
  const vars = { APP_ID: id, APP_NAME: opts.name.replace(/"/g, '\\"') };
  const root = templateRoot();
  const files = await listFiles(root);
  const written: string[] = [];

  await mkdir(opts.dir, { recursive: true });
  for (const src of files) {
    const rel = relative(root, src);
    const parts = rel.split(/[/\\]/).map(finalName);
    const destRel = parts.join("/");
    // headless = workers only: no human surfaces, so skip the form assets.
    if (headless && destRel.startsWith("forms/")) continue;
    const dest = join(opts.dir, destRel);
    await mkdir(dirname(dest), { recursive: true });
    const raw = await readFile(src, "utf8");
    let content = substitute(raw, vars);
    if (headless && destRel === "nano.app.json") content = toHeadlessManifest(content);
    await writeFile(dest, content);
    written.push(destRel);
  }
  return { dir: opts.dir, id, files: written.sort() };
}

/** headless preset: drop the human-facing surfaces, triggers and form models. */
function toHeadlessManifest(json: string): string {
  const m = JSON.parse(json) as {
    surfaces?: unknown;
    triggers?: unknown;
    models?: { forms?: unknown };
  };
  delete m.surfaces;
  delete m.triggers;
  if (m.models) delete m.models.forms;
  return JSON.stringify(m, null, 2) + "\n";
}

// Re-export for callers that want the template path (e.g. tests).
export { cp, stat };
