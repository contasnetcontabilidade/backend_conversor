import fs from "fs";
import path from "path";

function findProjectRoot(startDir: string) {
  let current = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  // Fallback for unexpected runtime layouts.
  return path.resolve(startDir, "..", "..", "..");
}

export function getProjectRoot() {
  // Works in both source tree and compiled/runtime tree.
  return findProjectRoot(__dirname);
}

export function resolveFromProjectRoot(...segments: string[]) {
  return path.resolve(getProjectRoot(), ...segments);
}
