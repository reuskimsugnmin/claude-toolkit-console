import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../../..");
export const FIXTURES_ROOT = path.join(REPO_ROOT, "fixtures");

export function readFixture(relPath: string): string {
  return readFileSync(path.join(FIXTURES_ROOT, relPath), "utf8");
}

export function readFixtureJson(relPath: string): unknown {
  return JSON.parse(readFixture(relPath));
}

export function readFixtureJsonl(relPath: string): unknown[] {
  return readFixture(relPath)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}
