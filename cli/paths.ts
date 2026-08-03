import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { errorMessage, failure, success, type Result } from "./result.ts";

export interface TrustedPath {
  readonly absolute: string;
  readonly relative: string;
}

export interface TrustedPathPolicy {
  /** Follow symlinks and prove the physical target remains beneath the physical root. */
  readonly requireRealpath?: boolean;
  readonly realpath?: (path: string) => string;
}

export function canonicalTrackedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function containedRelative(
  root: string,
  candidate: string,
): string | undefined {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" ||
    (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
    ? canonicalTrackedPath(fromRoot)
    : undefined;
}

/** Resolves untrusted input against a root and rejects lexical or physical escape. */
export function resolveTrustedPath(
  raw: string,
  root: string,
  policy: TrustedPathPolicy = {},
): Result<TrustedPath> {
  if (!raw.trim()) return failure("path is required");
  const trustedRoot = resolve(root);
  const candidate = resolve(trustedRoot, raw);
  const tracked = containedRelative(trustedRoot, candidate);
  if (tracked === undefined)
    return failure("path resolves outside the project root");
  if (!policy.requireRealpath)
    return success({ absolute: candidate, relative: tracked });

  const readRealpath = policy.realpath ?? realpathSync;
  try {
    const physicalRoot = readRealpath(trustedRoot);
    const physicalCandidate = readRealpath(candidate);
    const physicalRelative = containedRelative(physicalRoot, physicalCandidate);
    return physicalRelative === undefined
      ? failure("path escapes the project root through a symlink")
      : success({ absolute: physicalCandidate, relative: tracked });
  } catch (error: unknown) {
    return failure(`cannot resolve path: ${errorMessage(error)}`);
  }
}
