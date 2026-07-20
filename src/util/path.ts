import { isAbsolute, relative, resolve } from "node:path";
import { ToolInputError } from "../tools/types.js";

export function absPath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

// --- Workspace confinement (opt-in security boundary) ----------------------
//
// When a workspace root is set, file tools refuse to touch paths outside it —
// closing the gap where the permitless Read tool could read any absolute path
// (~/.ssh, /etc/passwd, ...). Off by default (root === null) so out-of-repo
// reads keep working; the composition root enables it from config. It is a
// process-wide policy (one session = one boundary), so a module-level value is
// the natural home; setWorkspaceRoot(null) resets it for tests.

let workspaceRoot: string | null = null;

export function setWorkspaceRoot(root: string | null): void {
  workspaceRoot = root === null ? null : resolve(root);
}

export function getWorkspaceRoot(): string | null {
  return workspaceRoot;
}

// True when abs is inside root (or is root itself).
function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Resolve a tool's file_path and enforce the workspace boundary when set.
// Throws ToolInputError (→ clean {isError} result via executeTool) on escape.
export function resolveToolPath(cwd: string, p: string): string {
  const abs = absPath(cwd, p);
  if (workspaceRoot !== null && !isWithin(workspaceRoot, abs)) {
    throw new ToolInputError(
      `path "${abs}" is outside the workspace root "${workspaceRoot}" (confineToWorkspace is on)`,
    );
  }
  return abs;
}
