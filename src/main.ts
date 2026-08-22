// ToolPkg main entry. This package is a pure tool set with no host-level
// hooks or UI modules, so registerToolPkg only acknowledges activation.

export function registerToolPkg(): boolean {
  return true;
}