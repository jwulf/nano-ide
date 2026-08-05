import { isRecord } from "../core/guards.ts";

export interface DenoRuntimeGlobal {
  version?: unknown;
  stdin?: { readable?: ReadableStream<Uint8Array> };
  args?: string[];
  exit?: (code: number) => void;
  addSignalListener?: (sig: string, cb: () => void) => void;
}

export interface ProcessRuntimeGlobal {
  argv?: string[];
  exit?: (code: number) => void;
  stdin?: AsyncIterable<Uint8Array | string> & { setEncoding?(encoding: string): void };
  on?: (sig: string, cb: () => void) => void;
}

export function denoGlobal(): DenoRuntimeGlobal | undefined {
  const value: unknown = Reflect.get(globalThis, "Deno");
  return isRecord(value) ? value : undefined;
}

export function processGlobal(): ProcessRuntimeGlobal | undefined {
  const value: unknown = Reflect.get(globalThis, "process");
  return isRecord(value) ? value : undefined;
}

