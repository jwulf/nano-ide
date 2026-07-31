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
        return await readdir(path);
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
