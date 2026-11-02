import { execFileSync } from "node:child_process";

/** Minimal glob matcher for repo paths: supports `**` (any depth) and `*` (one segment). */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (ch === "*") {
      re += "[^/]*";
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

export function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
}
