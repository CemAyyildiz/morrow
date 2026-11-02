// Fails when files that must stay private are tracked: planning, agent outputs, or
// any Markdown other than README.md.
import { pathToFileURL } from "node:url";
import { git } from "./lib.mjs";

const FORBIDDEN_DIRS = ["_bmad/", "_bmad-output/", ".claude/", "docs/", ".cursor/", ".codex/"];
const FORBIDDEN_FILES = ["CLAUDE.md", "AGENTS.md"];

export function findViolations(paths) {
  return paths.filter((path) => {
    const base = path.split("/").pop();
    if (FORBIDDEN_DIRS.some((dir) => path.startsWith(dir))) return true;
    if (FORBIDDEN_FILES.includes(base)) return true;
    return path.toLowerCase().endsWith(".md") && base !== "README.md";
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = findViolations(git(["ls-files"]));
  if (violations.length > 0) {
    console.error("Files that must not be published are tracked:");
    for (const path of violations) console.error(`  ${path}`);
    process.exit(1);
  }
  console.log("Repository hygiene: OK");
}
