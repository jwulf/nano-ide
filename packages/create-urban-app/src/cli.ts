#!/usr/bin/env node
// `npm create urban-app@latest <name>` / `deno run -A npm:create-urban-app <name>`
// Scaffolds a runnable Urban app in ./<name> (or --dir).

import { scaffold, slugify } from "./scaffold.ts";

interface Parsed {
  name?: string;
  dir?: string;
  id?: string;
  preset?: "full" | "headless";
  help?: boolean;
}

function parse(argv: string[]): Parsed {
  const out: Parsed = {};
  const rest: string[] = [];
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("-")) throw new Error(`flag ${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--dir") out.dir = need(++i, a);
    else if (a === "--id") out.id = need(++i, a);
    else if (a === "--preset") out.preset = need(++i, a) as "full" | "headless";
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else rest.push(a);
  }
  out.name = rest[0];
  return out;
}

const USAGE = `create-urban-app — scaffold a runnable Urban app

Usage:
  npm create urban-app@latest <name> [--dir <path>] [--id <slug>] [--preset full|headless]
  deno run -A npm:create-urban-app <name>

The scaffolded app runs on both Node and Deno via @nanobpm/urban.
`;

export async function main(argv: string[]): Promise<number> {
  const opts = parse(argv);
  if (opts.help || !opts.name) {
    console.log(USAGE);
    return opts.name ? 0 : 1;
  }
  const dir = opts.dir ?? `./${slugify(opts.name)}`;
  const res = await scaffold({
    name: opts.name,
    dir,
    id: opts.id,
    preset: opts.preset ?? "full",
  });
  console.log(`✔ Scaffolded "${res.id}" in ${res.dir} (${res.files.length} files)`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${dir}`);
  console.log(`  # Node:  npm install && npm run check && npm start`);
  console.log(`  # Deno:  deno task check && deno task start`);
  return 0;
}

const meta = import.meta as unknown as { main?: boolean; url: string };
const g = globalThis as {
  process?: { argv?: string[]; exit?: (c: number) => void };
  Deno?: { args?: string[] };
};
const argv0 = g.process?.argv?.[1];
const nodeMain = argv0 ? meta.url === new URL(`file://${argv0}`).href : false;
const isEntry = meta.main === true || nodeMain;

if (isEntry) {
  // Node passes args via process.argv (slice off exec+script); Deno (run directly)
  // exposes them on Deno.args. Prefer whichever actually carries args.
  const fromNode = g.process?.argv?.slice(2);
  const fromDeno = g.Deno?.args;
  const argv = (fromNode && fromNode.length ? fromNode : fromDeno) ?? fromNode ?? [];
  main(argv).then(
    (code) => g.process?.exit?.(code),
    (err) => {
      console.error(String((err as Error)?.message ?? err));
      g.process?.exit?.(1);
    },
  );
}
