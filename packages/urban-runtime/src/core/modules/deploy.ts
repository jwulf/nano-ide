// deploy — resolve the manifest `models` patterns and deploy the resources to the engine.

import type { RuntimeContext } from "../context.ts";
import { expandPatterns } from "../glob.ts";

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

/** Deploy all processes, decisions and forms declared under `models`. */
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
  const resources = await Promise.all(
    files.map(async (path) => ({
      name: baseName(path),
      content: await ctx.host.readTextFile(path),
      contentType: contentTypeFor(path),
    })),
  );
  const { deployed } = await ctx.engine.deployResources(resources);
  ctx.host.log("info", "deploy: models deployed", { deployed, files });
  return { deployed, files };
}
