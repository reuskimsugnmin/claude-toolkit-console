import { readFileSync } from "node:fs";
import path from "node:path";
import {
  attribute,
  normalizePath,
  TOKEN_SUM_DEFINITION_V1,
  type AssetKind,
  type AttributionSource,
  type Occupancy,
  type OccupancyFailureKind,
  type OccupancyValue,
  type SessionUsage,
  type UsageMetric,
} from "@ctk/core";
import {
  collectHarnessUsage,
  countTokensMeasured,
  createMapOffsetCacheStore,
  createMapTokenCacheStore,
  createNullTokenCacheStore,
  extractRow,
  fetchPluginDetails,
  findSkillDirsById,
  iterateTranscriptRows,
  listTranscriptFiles,
  readSubagentMeta,
  resolveHomeContext,
  type HomeContext,
} from "@ctk/probe";
import {
  acquireLock,
  appendOffsetCacheEntries,
  appendOffsetCacheEntriesAtPath,
  appendTokenCacheEntries,
  commitAll,
  ensureGitRepo,
  ensureMachine,
  fromOffsetCacheDirtyMap,
  fromTokenCacheDirtyMap,
  listAllAssets,
  readCatalogConfig,
  readOffsetCache,
  readOffsetCacheAtPath,
  readTokenCache,
  toOffsetCacheMap,
  toTokenCacheMap,
  upsertOccupancy,
  writeRunLog,
  writeSnapshot,
} from "@ctk/sync";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/measure.ts — `ctk measure` (plan §4 Step 3). 두 축을 한 실행에서 갱신한다:
 * ① **사용량**(트랜스크립트 파싱 → UsageMetric + SessionUsage, AC-4.1~4.3/4.6/4.7/4.9)
 * ② **점유**(카탈로그 자산의 idle/loaded 토큰, AC-4.4/4.5/4.8)
 *
 * **문서화된 범위 축소 (Step 3, executor 판단 — 남은 이슈로 보고).**
 * - `occupancy_loaded_tokens`는 **skill**만 실제 측정한다(SKILL.md 전문 재실측). **plugin**의
 *   loaded는 `unmeasured(reason: definition_pending)`로 남긴다 — §1.3 결정 5가 명시한 "산하
 *   스킬·에이전트 전문 합산"은 설치 플러그인 디렉터리를 훑어 번들 컴포넌트를 재구성해야 하는데,
 *   이는 Step 4(`gen`)의 콘텐츠 추출 책임과 겹치는 별도 기능이라 이 Step에서 손대지 않았다.
 * - **plugin의 idle**도 마찬가지로 "산하 스킬·에이전트 name+description 합"이 아니라 **플러그인
 *   자산 자체의 name+description만** 잰다 — 같은 이유.
 * - **R17 서브에이전트 교집합 검사는 이번 실행에서 새로 파싱된 범위(증분) 기준이다** — 오프셋
 *   캐시로 이미 읽은 과거 바이트는 다시 세지 않는다. 전체 이력 누적 대조가 아니라 "이번 실행에서
 *   관측된 Agent tool_use 대비 이번 실행에서 새로 발견된 subagent 파일 수"를 비교한다. 정직하게
 *   스코프를 좁힌 것이지 결과를 숨기는 것은 아니다 — summary에 두 카운트를 그대로 노출한다.
 */

export interface RunMeasureOptions {
  transcriptsDir?: string;
  noCredentialsOk?: boolean;
  /**
   * 테스트 주입용. 기본값은 실제 `countTokensMeasured`다.
   *
   * ⚠️ **주입 시드가 없으면 이 테스트들은 실행 머신의 크레덴셜 상태에 좌우된다.** 게이트가
   * SDK 해석 체인에 위임하게 된 이상 "env를 지웠으니 크레덴셜이 없다"가 더는 성립하지 않는다 —
   * `ant` 프로파일이 있는 머신에서는 같은 테스트가 다른 결과를 낸다. 크레덴셜 부재를 재현하려면
   * env 조작이 아니라 이 시드로 고정한다.
   */
  countTokensFn?: typeof countTokensMeasured;
}

/**
 * 크레덴셜 가용성 판정에 쓰는 최소 탐침 텍스트. 내용은 무의미하고 **호출이 성립하는지**만 본다.
 * 캐시에 넣지 않는다(실제 자산 측정값과 섞이면 안 된다 — null 캐시로 호출한다).
 */
const CREDENTIAL_PROBE_TEXT = "ctk credential probe";

export class CredentialMissingError extends Error {
  readonly failureClass = "credential_missing" as const;
  constructor() {
    super(
      "count_tokens 크레덴셜이 어느 경로로도 해석되지 않았다 — SDK는 ANTHROPIC_API_KEY → " +
        "ANTHROPIC_AUTH_TOKEN → `ant auth login` 프로파일 → Workload Identity 순으로 찾는다. " +
        "occupancy를 unmeasured로 기록하려면 --no-credentials-ok를 명시해야 한다" +
        "(AC-4.5, 조용한 성공으로 바꾸지 않는다).",
    );
    this.name = "CredentialMissingError";
  }
}

/**
 * `measurement_failed` 원인 분류별 복구 안내(안전 원칙 6 — 가드에는 빠져나갈 길을 함께 준다).
 * 분류를 못 한 경우까지 포함해 **모든 분기가 한 줄을 돌려준다** — 안내가 비면 사용자는 화면에
 * "실패"만 남은 상태로 되돌아간다.
 */
export function measurementFailureHint(kind: OccupancyFailureKind): string {
  switch (kind) {
    case "tls_chain_untrusted":
      return (
        "TLS 체인 검증 실패 — 가로채기 프록시의 루트 CA가 Node 신뢰 저장소에 없다. " +
        "해당 루트 CA를 PEM으로 내보내 NODE_EXTRA_CA_CERTS로 지정한다(TLS 검증을 끄지 않는다)."
      );
    case "network_unreachable":
      return "네트워크 도달 실패 — 오프라인·DNS·방화벽·프록시 설정을 확인한다.";
    case "rate_limited":
      return "레이트리밋(429) — 잠시 후 재실행한다. 토큰 캐시가 있어 재실행은 이미 측정된 자산을 다시 호출하지 않는다.";
    case "api_error":
      return "API가 오류 상태로 응답했다 — 조직 권한·워크스페이스 설정을 확인한다.";
    case "unclassified":
      return "원인을 분류하지 못했다 — 같은 조건에서 재현되면 ctk 이슈로 남긴다(분류를 추측해 채우지 않는다).";
  }
}

export interface MeasureSummary {
  catalogPath: string;
  snapshotPath: string;
  runLogPath: string;
  transcriptFilesParsed: number;
  parseFailureCount: number;
  usageMetricCount: number;
  sessionUsageCount: number;
  occupancyCount: number;
  occupancyDivergenceCount: number;
  usageDivergenceCount: number;
  unattributedCallCount: number;
  agentToolUseCountThisRun: number;
  newSubagentFilesThisRun: number;
  subagentAttributionGap: boolean;
  credentialsAvailable: boolean;
  /** 크레덴셜 탐침이 `measurement_failed`였을 때의 원인 분류. 그 외에는 null. */
  credentialProbeFailureKind: OccupancyFailureKind | null;
  durationMs: number;
}

interface UsageAgg {
  kind: string;
  ref: string;
  projectPathHash: string | null;
  callCount: number;
  lastUsedAt: string | null;
  tokenSum: number;
  attributionSource: AttributionSource;
  attributionRule: string;
  subagentAttribution: UsageMetric["subagent_attribution"];
}

interface SessionAgg {
  sessionId: string;
  projectPathHash: string | null;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  latestTimestamp: string | null;
}

function aggKey(kind: string, ref: string, projectPathHash: string | null): string {
  return `${kind}${ref}${projectPathHash ?? ""}`;
}

function laterTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

export async function runMeasure(options: RunMeasureOptions = {}): Promise<MeasureSummary> {
  const startedAt = new Date();
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");
  const catalogConfig = readCatalogConfig(catalogPath);
  if (catalogConfig === null) throw new CatalogNotInitializedError();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const countTokensFn = options.countTokensFn ?? countTokensMeasured;

  // 크레덴셜 가용성은 **SDK가 판정한다.** env 하나를 직접 보던 옛 게이트는 `ant auth login`
  // 프로파일로 측정 가능한 사용자를 credential_missing으로 거부했다(2026-08-24 실측) —
  // count-tokens.ts는 이미 전체 체인에 위임하도록 고쳐져 있었는데 이 게이트만 배선이 빠져 있었다.
  // 판정 주체를 하나로 두면 SDK가 체인을 바꿔도 여기가 따라 틀리지 않는다(안전 원칙 7 — 판정할
  // 수 없는 것을 흉내 내 그럴듯한 값을 만들지 않는다).
  //
  // 락 획득 **이전에** 탐침한다 — 네트워크 왕복 동안 카탈로그 락을 쥐고 있을 이유가 없다.
  const credentialProbe = await countTokensFn({
    text: CREDENTIAL_PROBE_TEXT,
    tokenizerModel: catalogConfig.tokenizer_model,
    cache: createNullTokenCacheStore(),
    apiKey,
  });
  // "크레덴셜 없음"과 "크레덴셜은 있는데 측정 실패"는 다른 상태다(안전 원칙 7). 후자는 게이트를
  // 통과시키고 결과를 정직하게 unmeasured(measurement_failed)로 남긴다 — 여기서 막아버리면
  // 사용자는 있지도 않은 크레덴셜 문제를 찾게 된다.
  const credentialsAvailable = !(
    credentialProbe.state === "unmeasured" && credentialProbe.reason === "credential_missing"
  );
  if (!credentialsAvailable && options.noCredentialsOk !== true) {
    throw new CredentialMissingError();
  }
  const credentialProbeFailureKind =
    credentialProbe.state === "unmeasured" && credentialProbe.reason === "measurement_failed"
      ? (credentialProbe.failure_kind ?? "unclassified")
      : null;
  if (credentialProbeFailureKind !== null) {
    console.warn(
      `WARN measurement_failed(${credentialProbeFailureKind}): ${measurementFailureHint(credentialProbeFailureKind)}`,
    );
  }

  const lock = acquireLock(catalogPath, {
    command: "measure",
    origin: "cli",
    started_at: startedAt.toISOString(),
    machine_id: machine.machine_id,
  });

  try {
    ensureGitRepo(catalogPath);
    ensureMachine(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      id: machine.machine_id,
      alias: machine.alias,
      first_seen_at: startedAt.toISOString(),
    });

    // ── 캐시 적재 (P1-8 — probe는 CacheStore 인터페이스만, 읽기·쓰기는 sync) ──
    const tokenStore = createMapTokenCacheStore(toTokenCacheMap(readTokenCache(catalogPath)));

    const localOffsetsPath = path.join(home.ctkHome, ".cache", "ctk", "offsets.jsonl");
    const offsetRecords =
      catalogConfig.offset_cache_location === "local"
        ? readOffsetCacheAtPath(localOffsetsPath)
        : readOffsetCache(catalogPath, machine.machine_id);
    const offsetStore = createMapOffsetCacheStore(toOffsetCacheMap(offsetRecords));

    // ── 트랜스크립트 스트리밍 파싱 ──
    const projectsRoot = options.transcriptsDir ?? path.join(home.ctkConfigDir, "projects");
    const files = listTranscriptFiles(projectsRoot);

    const usageAggs = new Map<string, UsageAgg>();
    const sessionAggs = new Map<string, SessionAgg>();
    let parseFailureCount = 0;
    let unattributedCallCount = 0;
    let agentToolUseCountThisRun = 0;
    let newSubagentFilesThisRun = 0;

    for (const file of files) {
      const startOffset = offsetStore.get(file.pathHash) ?? 0;
      const isNewFile = startOffset === 0;
      if (file.isSidechain && isNewFile) newSubagentFilesThisRun += 1;

      const pendingToolUses = new Map<string, string>(); // toolUseId -> aggKey
      let lastOffset = startOffset;

      for await (const line of iterateTranscriptRows(file.absPath, startOffset)) {
        lastOffset = line.byteOffsetAfter;
        if (!line.ok) {
          parseFailureCount += 1;
          continue;
        }
        const extracted = extractRow(line.row);
        const projectPathHash = extracted.projectPath !== null ? normalizePath(extracted.projectPath, home.ctkHome).path_hash : null;

        for (const toolUse of extracted.toolUses) {
          if (!file.isSidechain && toolUse.toolName === "Agent") agentToolUseCountThisRun += 1;

          const decision = attribute({ toolName: toolUse.toolName, toolInput: toolUse.toolInput, explicit: toolUse.explicit });
          if (decision.kind === null || decision.ref === null) {
            unattributedCallCount += 1;
            continue;
          }
          const key = aggKey(decision.kind, decision.ref, projectPathHash);
          const existing = usageAggs.get(key);
          const subagentAttribution: UsageMetric["subagent_attribution"] = decision.kind === "agent" ? "unresolved" : "not_applicable";
          if (existing === undefined) {
            usageAggs.set(key, {
              kind: decision.kind,
              ref: decision.ref,
              projectPathHash,
              callCount: 1,
              lastUsedAt: extracted.timestamp,
              tokenSum: 0,
              attributionSource: decision.attribution_source,
              attributionRule: decision.attribution_rule,
              subagentAttribution,
            });
          } else {
            existing.callCount += 1;
            existing.lastUsedAt = laterTimestamp(existing.lastUsedAt, extracted.timestamp);
          }
          if (toolUse.toolUseId !== undefined) pendingToolUses.set(toolUse.toolUseId, key);
        }

        for (const toolResult of extracted.toolResults) {
          if (toolResult.toolUseId === undefined) continue; // 레거시 폼(짝 없음) — 귀속 불가, 정직하게 건너뜀
          const key = pendingToolUses.get(toolResult.toolUseId);
          if (key === undefined) continue; // 오프셋 재개 경계를 넘어 짝이 이 실행 범위 밖에 있음
          // ⚠️ **세 번째 호출 경로다.** `token_sum`(AC-4.3)은 occupancy와 별개로 tool_result
          // 페이로드를 잰다 — 게이트·occupancy만 주입에 배선하고 여기를 빠뜨리면 테스트가
          // 크레덴셜 부재를 주입해 놓고도 **실제 네트워크를 탄다**(실측: 같은 테스트가 회선
          // 상태에 따라 token_sum 0 또는 17을 냈다). 호출 지점을 늘릴 때는 세어서 전부 배선한다.
          const measured = await countTokensFn({
            text: toolResult.text,
            tokenizerModel: catalogConfig.tokenizer_model,
            cache: tokenStore,
            apiKey,
          });
          if (measured.state === "measured") {
            const agg = usageAggs.get(key);
            if (agg !== undefined) agg.tokenSum += measured.value_tokens;
          }
        }

        if (extracted.usage !== null && extracted.sessionId !== null) {
          const sKey = extracted.sessionId;
          const sExisting = sessionAggs.get(sKey);
          if (sExisting === undefined) {
            sessionAggs.set(sKey, {
              sessionId: sKey,
              projectPathHash,
              input: extracted.usage.input_tokens,
              output: extracted.usage.output_tokens,
              cacheCreation: extracted.usage.cache_creation_input_tokens,
              cacheRead: extracted.usage.cache_read_input_tokens,
              latestTimestamp: extracted.timestamp,
            });
          } else {
            sExisting.input += extracted.usage.input_tokens;
            sExisting.output += extracted.usage.output_tokens;
            sExisting.cacheCreation += extracted.usage.cache_creation_input_tokens;
            sExisting.cacheRead += extracted.usage.cache_read_input_tokens;
            sExisting.latestTimestamp = laterTimestamp(sExisting.latestTimestamp, extracted.timestamp);
          }
        }
      }

      offsetStore.set(file.pathHash, lastOffset);
      // subagent 메타(R17 대조 근거)는 존재만 확인한다 — 이번 Step은 agentId↔toolUseId 완전
      // 역추적을 UsageMetric에 싣지 않는다(진단 신호로는 subagentAttributionGap으로 충분).
      if (file.metaPath !== null) readSubagentMeta(file.metaPath);
    }

    const subagentAttributionGap = agentToolUseCountThisRun !== newSubagentFilesThisRun;

    // ── 하네스 사용량 교차검증 (AC-4.9) ──
    const harnessUsage = collectHarnessUsage(home);

    const usageMetrics: UsageMetric[] = [...usageAggs.values()].map((agg) => {
      // ⚠️ `agg.kind`는 core/usage/attribution.ts의 `AttributionTargetKind`이지 `AssetKind`가
      // 아니다(같은 이름 "agent"가 두 유니온에 각각 있다 — attribution.ts의 대응 주석 참조).
      // "agent" 대조를 여기 추가하지 않는 것은 누락이 아니라 의도다: agg.ref는 맨 subagent_type
      // 문자열이고 하네스 usage 맵은 카탈로그 Asset.id(`<부모플러그인id>:<이름>`) 키를 쓰므로,
      // 변환 없이 대입하면 항상 못 찾는(우연히 안전하지만 뜻 없는) 조회가 된다.
      const harnessEntry =
        agg.kind === "skill" ? harnessUsage.skillUsage[agg.ref] : agg.kind === "plugin" ? harnessUsage.pluginUsage[agg.ref] : undefined;
      const harnessUsageCount = harnessEntry?.usageCount ?? null;
      const harnessLastUsedAt = harnessEntry?.lastUsedAt ?? null;
      const usageDivergence = harnessUsageCount !== null && harnessUsageCount !== agg.callCount;
      return {
        schema_version: 1,
        _scope: "machine_dependent",
        asset_id: agg.ref,
        machine_id: machine.machine_id,
        project_path_hash: agg.projectPathHash,
        call_count: agg.callCount,
        token_sum: agg.tokenSum,
        token_sum_definition: TOKEN_SUM_DEFINITION_V1,
        last_used_at: agg.lastUsedAt,
        attribution_source: agg.attributionSource,
        attribution_rule: agg.attributionRule,
        subagent_attribution: subagentAttributionGap && agg.subagentAttribution === "unresolved" ? "unresolved" : agg.subagentAttribution,
        harness_usage_count: harnessUsageCount,
        harness_last_used_at: harnessLastUsedAt,
        usage_divergence: usageDivergence,
      };
    });

    const sessionUsageRecords: SessionUsage[] = [...sessionAggs.values()].map((s) => ({
      schema_version: 1,
      _scope: "machine_dependent",
      __kind: "session_usage",
      session_id: s.sessionId,
      machine_id: machine.machine_id,
      project_path_hash: s.projectPathHash,
      input_tokens: s.input,
      output_tokens: s.output,
      cache_creation_input_tokens: s.cacheCreation,
      cache_read_input_tokens: s.cacheRead,
      measured_at: startedAt.toISOString(),
    }));

    // ── 점유(occupancy) 측정 (AC-4.4/4.5/4.8) ──
    const assets = listAllAssets(catalogPath);
    const occupancyRecords: Occupancy[] = [];
    const tmpCwd = catalogPath; // plugin details 호출용 cwd — 구조적 서브커맨드라 프로젝트 설정 유입 위험 없음(spawn-claude.ts가 어차피 argv를 전량 구성)

    for (const asset of assets) {
      const { idle, loaded } = await computeOccupancy(asset, home, tokenStore, catalogConfig.tokenizer_model, apiKey, countTokensFn);

      let harnessAlwayson: Occupancy["harness_alwayson"] = { state: "unmeasured", value_tokens: null, reason: "not_a_plugin" };
      if (asset.kind === "plugin") {
        const detailsResult = await fetchPluginDetails(asset.id, { home, cwd: tmpCwd, timeoutSec: 20 });
        if ("details" in detailsResult) {
          harnessAlwayson = {
            state: "measured",
            value_tokens: detailsResult.details.projected_token_cost.always_on_tokens,
            source: "plugin_details_parse",
            measured_at: startedAt.toISOString(),
          };
        } else {
          harnessAlwayson = { state: "unmeasured", value_tokens: null, reason: detailsResult.error };
        }
      }

      let occupancyDivergence = false;
      let occupancyDivergenceRatio: number | null = null;
      if (idle.state === "measured" && harnessAlwayson.state === "measured") {
        const denom = Math.max(harnessAlwayson.value_tokens, 1);
        occupancyDivergenceRatio = Math.abs(idle.value_tokens - harnessAlwayson.value_tokens) / denom;
        occupancyDivergence = occupancyDivergenceRatio * 100 > catalogConfig.occupancy_divergence_threshold_pct;
      }

      occupancyRecords.push({
        schema_version: 1,
        _scope: "machine_independent",
        asset_id: asset.id,
        idle,
        loaded,
        idle_definition: "harness-parity",
        harness_alwayson: harnessAlwayson,
        occupancy_divergence: occupancyDivergence,
        occupancy_divergence_ratio: occupancyDivergenceRatio,
      });
      upsertOccupancy(catalogPath, asset.kind, asset.name, asset.id, occupancyRecords[occupancyRecords.length - 1]!);
    }

    // ── 캐시 신규분 flush (sync가 유일한 쓰기 주체) ──
    appendTokenCacheEntries(catalogPath, fromTokenCacheDirtyMap(tokenStore.dirty));
    if (catalogConfig.offset_cache_location === "local") {
      appendOffsetCacheEntriesAtPath(localOffsetsPath, fromOffsetCacheDirtyMap(offsetStore.dirty));
    } else {
      appendOffsetCacheEntries(catalogPath, machine.machine_id, fromOffsetCacheDirtyMap(offsetStore.dirty));
    }

    const snapshot = writeSnapshot(catalogPath, machine.machine_id, startedAt.toISOString(), [...usageMetrics, ...sessionUsageRecords]);

    const finishedAt = new Date();
    const runLog = writeRunLog(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "measure",
      args: {
        counts: {
          transcript_files: files.length,
          parse_failures: parseFailureCount,
          usage_metrics: usageMetrics.length,
          occupancy: occupancyRecords.length,
          // R17 — ctk doctor가 이 run-log를 읽어 괴리를 노출한다(수용 기준: "subagent_attribution:
          // unresolved + ctk doctor 노출" 중 하나로 기록). measure 자신의 stdout 요약과 별도로
          // 진단 커맨드에서도 조회 가능해야 하므로 run-log에 그대로 싣는다.
          agent_tool_use_count_this_run: agentToolUseCountThisRun,
          new_subagent_files_this_run: newSubagentFilesThisRun,
        },
      },
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      exit_code: 0,
      // 실행 자체는 성공(exit 0)이지만, R17 괴리가 있으면 진단 분류를 run-log에 남겨 ctk doctor가
      // 조용히 지나치지 않게 한다 — "0을 사실로 기록하는 것이 가장 나쁜 실패"라는 원칙의 연장.
      failure_class: subagentAttributionGap ? "subagent_attribution_unresolved" : null,
    });

    commitAll(catalogPath, `ctk measure: ${startedAt.toISOString()}`);

    return {
      catalogPath,
      snapshotPath: snapshot.path,
      runLogPath: runLog.path,
      transcriptFilesParsed: files.length,
      parseFailureCount,
      usageMetricCount: usageMetrics.length,
      sessionUsageCount: sessionUsageRecords.length,
      occupancyCount: occupancyRecords.length,
      occupancyDivergenceCount: occupancyRecords.filter((o) => o.occupancy_divergence).length,
      usageDivergenceCount: usageMetrics.filter((u) => u.usage_divergence).length,
      unattributedCallCount,
      agentToolUseCountThisRun,
      newSubagentFilesThisRun,
      subagentAttributionGap,
      credentialsAvailable,
      credentialProbeFailureKind,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  } finally {
    lock.release();
  }
}

/**
 * kind별 idle/loaded 측정. §1.3 결정 5의 4-kind 공식 중 **skill의 idle(name+description)과
 * loaded(SKILL.md 전문)만 완전 구현**한다. plugin의 idle은 자기 자신의 name+description만(산하
 * 컴포넌트 합산은 범위 밖, 파일 상단 주석 참조), loaded는 definition_pending. mcp/cli는 decision 5가
 * 명시한 대로 0(harness-parity/구조적으로 본문 없음) — 이건 "측정 실패"가 아니라 **정의상 0**이라
 * `measured` 상태로 기록한다(하네스 자신이 "not counted"라고 선언한 값을 그대로 받아쓰는 것 —
 * P6. 문자 수 어림값이 아니므로 approx_bytes가 아니다).
 *
 * ⚠️ **B1 Step 2 — exhaustive switch(결정 2 #12, 안전 원칙 7).** 이전에는 `if/if` 사슬의 마지막이
 * skill 처리로 "떨어졌다" — kind가 늘어나면 새 값도 조용히 skill 분기로 떨어져 SKILL.md를 못 찾고
 * `measurement_failed`("실패")를 냈다. 실제로는 "아직 정의가 없다"("없음")인데도 그랬다. 지금은
 * kind마다 명시적으로 답하고, 새 kind가 추가되면 이 함수가 컴파일에서 깬다.
 */
async function computeOccupancy(
  asset: { id: string; kind: AssetKind; name: string; description?: string },
  home: HomeContext,
  tokenStore: ReturnType<typeof createMapTokenCacheStore>,
  tokenizerModel: string,
  apiKey: string | undefined,
  /** 게이트와 **같은 함수**를 쓴다 — 탐침과 실측이 다른 경로를 타면 게이트가 통과시킨 조건이
   * 실제 측정에서 재현되지 않는다(테스트에서도 마찬가지다). */
  countTokensFn: typeof countTokensMeasured,
): Promise<{ idle: OccupancyValue; loaded: OccupancyValue }> {
  switch (asset.kind) {
    case "mcp":
    case "cli": {
      const zero: OccupancyValue = {
        state: "measured",
        value_tokens: 0,
        tokenizer_model: tokenizerModel,
        measured_at: new Date().toISOString(),
      };
      return { idle: zero, loaded: zero };
    }

    case "plugin": {
      const idleText = `${asset.name}\n${asset.description ?? ""}`;
      const idle = await countTokensFn({ text: idleText, tokenizerModel, cache: tokenStore, apiKey });
      // 산하 스킬·에이전트 전문 합산은 범위 밖(파일 상단 주석) — "측정 안 함"이지 "0"이 아니므로
      // definition_pending으로 명시한다. not_applicable(개념 자체가 없음)과는 다른 사유다.
      return { idle, loaded: { state: "unmeasured", value_tokens: null, reason: "definition_pending" } };
    }

    case "agent":
    case "command": {
      // 번들 자식(B1 Step 2 — 값만 추가됨, Step 5에서 편입). SKILL.md 같은 정형 본문 경로가
      // 아직 없다 — "측정 실패"가 아니라 "아직 정의가 없다"이므로 definition_pending을 쓴다.
      const idleText = `${asset.name}\n${asset.description ?? ""}`;
      const idle = await countTokensFn({ text: idleText, tokenizerModel, cache: tokenStore, apiKey });
      return { idle, loaded: { state: "unmeasured", value_tokens: null, reason: "definition_pending" } };
    }

    case "skill": {
      const idleText = `${asset.name}\n${asset.description ?? ""}`;
      const idle = await countTokensFn({ text: idleText, tokenizerModel, cache: tokenStore, apiKey });
      // 실제 SKILL.md 전문을 재실측한다.
      const dirs = findSkillDirsById(home, asset.id);
      if (dirs.length !== 1) {
        return { idle, loaded: { state: "unmeasured", value_tokens: null, reason: "measurement_failed" } };
      }
      let body: string;
      try {
        body = readFileSync(path.join(dirs[0]!.absPath, "SKILL.md"), "utf8");
      } catch {
        return { idle, loaded: { state: "unmeasured", value_tokens: null, reason: "measurement_failed" } };
      }
      const loaded = await countTokensFn({ text: body, tokenizerModel, cache: tokenStore, apiKey });
      return { idle, loaded };
    }
  }
}
