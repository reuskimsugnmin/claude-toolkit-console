import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCliTools } from "../src/sources/cli-path.js";
import { buildFixtureHome, type FixtureHome } from "./support/fixture-home.js";

describe("probe/sources/cli-path — PATH 상 알려진 CLI 도구만 탐지(occupancy 상시 0)", () => {
  let fixture: FixtureHome;
  let binDir: string;
  afterEach(() => {
    fixture?.cleanup();
    if (binDir) rmSync(binDir, { recursive: true, force: true });
  });

  it("알려진 이름과 일치하는 실행 파일이 PATH에 있으면 자산으로 잡힌다", () => {
    fixture = buildFixtureHome();
    binDir = mkdtempSync(path.join(tmpdir(), "ctk-bin-"));
    const codexPath = path.join(binDir, "codex");
    writeFileSync(codexPath, "#!/bin/sh\necho fake\n");
    chmodSync(codexPath, 0o755);

    const result = collectCliTools({
      home: fixture.home,
      machineId: "m1",
      pathEnv: binDir,
      knownNames: ["codex", "definitely-not-installed-xyz"],
    });
    expect(result.assets.map((a) => a.id)).toEqual(["codex"]);
    expect(result.installations).toHaveLength(1);
  });

  it("PATH에 없는 알려진 이름은 자산으로 잡히지 않는다", () => {
    fixture = buildFixtureHome();
    const result = collectCliTools({
      home: fixture.home,
      machineId: "m1",
      pathEnv: "/definitely/not/a/real/dir",
      knownNames: ["definitely-not-installed-xyz"],
    });
    expect(result.assets).toHaveLength(0);
  });
});
