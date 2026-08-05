// deploy — resolve the manifest `models` patterns and deploy the resources to the engine,
// substituting any `{{name}}` templates into each resource first (see templates.ts).

import type { RuntimeContext } from "../context.ts";
import { expandPatterns } from "../glob.ts";
import { applyTemplates, resolveTemplates } from "./templates.ts";

function contentTypeFor(path: string): string {
  if (path.endsWith(".bpmn")) return "text/xml";
  if (path.endsWith(".dmn")) return "text/xml";
  if (path.endsWith(".form")) return "application/json";
  return "application/octet-stream";
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Deploy all processes, decisions and forms declared under `models`. Each resource has its
 *  `{{name}}` placeholders substituted (manifest `models.templates`, then the programmatic
 *  `ctx.templates`, the latter winning) before it is sent to the engine. */
export async function deployModels(ctx: RuntimeContext): Promise<{ deployed: number; files: string[] }> {
  const models = ctx.manifest.models ?? {};
  const patterns = [
    ...(models.processes ?? []),
    ...(models.decisions ?? []),
    ...(models.forms ?? []),
  ];
  const files = await expandPatterns(ctx.host, ctx.root, patterns);
  if (files.length === 0) {
    ctx.host.log("info", "deploy: no model files matched", { patterns });
    return { deployed: 0, files: [] };
  }
  // Resolve templates once (manifest globs/dirs, then the programmatic deploy option). An empty
  // map makes substitution a no-op, so apps that use no templates are unaffected.
  const templates = await resolveTemplates(ctx.host, ctx.root, [models.templates, ctx.templates]);
  const hasTemplates = Object.keys(templates).length > 0;
  const resources = await Promise.all(
    files.map(async (path) => {
      const contentType = contentTypeFor(path);
      let content = await ctx.host.readTextFile(path);
      if (hasTemplates) {
        const applied = applyTemplates(content, contentType, templates);
        content = applied.content;
        if (applied.unresolved.length > 0) {
          ctx.host.log("warn", "deploy: unresolved template placeholders", {
            file: baseName(path),
            unresolved: applied.unresolved,
          });
        }
      }
      return { name: baseName(path), content, contentType };
    }),
  );
  const { deployed } = await ctx.engine.deployResources(resources);
  ctx.host.log("info", "deploy: models deployed", { deployed, files });
  return { deployed, files };
}
