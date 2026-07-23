import { isAbsolute, relative, resolve as pathResolve } from "node:path";
import { ToolInputError } from "../tools/types.js";

export function absPath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : pathResolve(cwd, p);
}

function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveToolPath(
  cwd: string,
  p: string,
  workspaceRoot: string | undefined,
): string {
  const abs = absPath(cwd, p);
  if (workspaceRoot !== undefined && !isWithin(workspaceRoot, abs)) {
    throw new ToolInputError(
      `path "${abs}" is outside the workspace root "${workspaceRoot}" (confineToWorkspace is on)`,
    );
  }
  return abs;
}
