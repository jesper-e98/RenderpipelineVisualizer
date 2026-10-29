import type { MeshData } from '../model/types';

/**
 * Heavy, pure, per-mesh computations that slides need once (e.g. a vertex-cache simulation over
 * every index). They run in a worker during `Derived.prepare()` and are cached; `Derived.compute()`
 * falls back to running them on the main thread if the worker result isn't there.
 *
 * Each entry must be a pure function of the mesh (+ JSON-serialisable args) returning
 * structured-clonable data.
 */
const REGISTRY = {} as Record<string, (mesh: MeshData, args: never) => unknown>;

export type ComputeKind = string;

export function registerCompute<A, R>(kind: string, fn: (mesh: MeshData, args: A) => R): (mesh: MeshData, args: A) => R {
  REGISTRY[kind] = fn as (mesh: MeshData, args: never) => unknown;
  return fn;
}

export function runCompute(kind: ComputeKind, mesh: MeshData, args: unknown): unknown {
  const fn = REGISTRY[kind];
  if (!fn) throw new Error(`unknown compute kind ${kind}`);
  return fn(mesh, args as never);
}

export function computeKinds(): string[] {
  return Object.keys(REGISTRY);
}
