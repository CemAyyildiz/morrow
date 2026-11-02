// Fails when a lane branch (lane-a/…, lane-b/…, lane-c/…) changes files outside its lane.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { git, matchesAny } from "./lib.mjs";

export function laneOf(branch) {
  const match = /^lane-([abc])\//.exec(branch ?? "");
  return match ? match[1] : null;
}

export function filesOutsideLane(lane, paths, config) {
  const allowed = [...config.lanes[lane], ...config.shared];
  return paths.filter((path) => !matchesAny(path, allowed));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const branch = process.env.GITHUB_HEAD_REF || git(["rev-parse", "--abbrev-ref", "HEAD"])[0];
  const lane = laneOf(branch);
  if (!lane) {
    console.log(`Lane check skipped: branch "${branch}" is not a lane branch.`);
    process.exit(0);
  }
  const base = process.env.LANE_BASE_REF || "origin/main";
  const config = JSON.parse(readFileSync(new URL("../lanes.json", import.meta.url), "utf8"));
  const changed = git(["diff", "--name-only", `${base}...HEAD`]);
  const outside = filesOutsideLane(lane, changed, config);
  if (outside.length > 0) {
    console.error(
      `Branch "${branch}" (lane ${lane.toUpperCase()}) changes files outside its lane:`,
    );
    for (const path of outside) console.error(`  ${path}`);
    process.exit(1);
  }
  console.log(
    `Lane check: ${changed.length} changed files, all inside lane ${lane.toUpperCase()}.`,
  );
}
