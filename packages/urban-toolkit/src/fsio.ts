// Node/Deno filesystem implementation of the GenIO port. Uses node:fs/promises, which both
// Node and Deno provide, so a single implementation serves both runtimes.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GenIO } from "./gen.ts";

export function createNodeGenIO(): GenIO {
  return {
    async readText(path: string): Promise<string> {
      return readFile(path, "utf8");
    },
    async writeText(path: string, content: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    async listDir(path: string): Promise<string[]> {
      try {
        // The GenIO contract is file names only — exclude subdirectories so
        // pattern expansion never hands a directory to readText()/JSON.parse.
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    async exists(path: string): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
