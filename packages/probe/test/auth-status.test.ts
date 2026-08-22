import { describe, expect, it } from "vitest";
import { checkSealedLiveAuthStatus } from "../src/auth-status.js";
import type { HomeContext } from "../src/home.js";

const HOME: HomeContext = { ctkHome: "/synthetic/home", ctkConfigDir: "/synthetic/home/.claude", configDirExplicit: true };

describe("probe/auth-status — sealed-live 0원 인증 가용성 신호 (docs/harness-facts.md)", () => {
  it("loggedIn:true JSON을 반환하면 loggedIn:true를 돌려준다(email 등 PII는 전달하지 않는다)", async () => {
    const spawnFn = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, email: "should-not-be-read@example.com" }),
      stderr: "",
      timedOut: false,
    });
    const result = await checkSealedLiveAuthStatus({ home: HOME, cwd: "/tmp", timeoutSec: 5, spawnFn: spawnFn as never });
    expect(result).toEqual({ loggedIn: true });
  });

  it("loggedIn:false면 false를 돌려준다", async () => {
    const spawnFn = async () => ({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false });
    const result = await checkSealedLiveAuthStatus({ home: HOME, cwd: "/tmp", timeoutSec: 5, spawnFn: spawnFn as never });
    expect(result).toEqual({ loggedIn: false });
  });

  it("명령 실패(exitCode != 0)는 loggedIn:false로 열화한다(안전한 방향)", async () => {
    const spawnFn = async () => ({ exitCode: 1, stdout: "", stderr: "error", timedOut: false });
    const result = await checkSealedLiveAuthStatus({ home: HOME, cwd: "/tmp", timeoutSec: 5, spawnFn: spawnFn as never });
    expect(result).toEqual({ loggedIn: false });
  });

  it("파싱 불가한 stdout도 loggedIn:false로 열화한다", async () => {
    const spawnFn = async () => ({ exitCode: 0, stdout: "not json", stderr: "", timedOut: false });
    const result = await checkSealedLiveAuthStatus({ home: HOME, cwd: "/tmp", timeoutSec: 5, spawnFn: spawnFn as never });
    expect(result).toEqual({ loggedIn: false });
  });

  it("sealed-live 프로파일로 spawn하고 구조적 서브커맨드(auth status --json)를 쓴다(모델 세션 아님)", async () => {
    let capturedProfile: string | undefined;
    let capturedSubcommand: string[] | undefined;
    const spawnFn = async (opts: { profile: string; subcommand: string[] }) => {
      capturedProfile = opts.profile;
      capturedSubcommand = opts.subcommand;
      return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "", timedOut: false };
    };
    await checkSealedLiveAuthStatus({ home: HOME, cwd: "/tmp", timeoutSec: 5, spawnFn: spawnFn as never });
    expect(capturedProfile).toBe("sealed-live");
    expect(capturedSubcommand).toEqual(["auth", "status", "--json"]);
  });
});
