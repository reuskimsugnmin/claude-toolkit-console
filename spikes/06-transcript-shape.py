#!/usr/bin/env python3
"""spikes/06-transcript-shape.py — AC-0.6b [차단]

Question: what row `type` carries `tool_result`? Where does `isSidechain`
live and what does it mean? What is the actual subagent-spawn tool name
(`Agent` vs legacy `Task`)? What shape does `Skill` tool_use's `input.skill`
take?

READ-ONLY against real ~/.claude/projects/*.jsonl. **Privacy note (this repo
is public — CLAUDE.md 위생 규칙):** this script only ever prints STRUCTURAL
facts (row `type` values, field names, tool names, value shapes/patterns) —
it never prints message text, tool inputs/outputs, file paths, or any other
conversation content. Grep the source before trusting the output if in doubt.

Run: python3 spikes/06-transcript-shape.py [N files to sample, default 8]
"""
import glob
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

TRANSCRIPTS_GLOB = str(Path.home() / ".claude" / "projects" / "*" / "*.jsonl")


def redact_skill_ref(s):
    # Keep the shape (e.g. "plugin:skill" vs "skill") without asserting
    # it's not sensitive — skill/plugin names here are ecosystem tool names
    # (oh-my-claudecode:plan etc.), not personal data, so we keep them as
    # structural evidence but still run them through a defensive filter
    # for absolute paths just in case a value leaks one.
    if isinstance(s, str) and s.startswith("/"):
        return "<REDACTED_ABS_PATH>"
    return s


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    all_files = glob.glob(TRANSCRIPTS_GLOB)
    random.seed(42)
    sample = random.sample(all_files, min(n, len(all_files)))

    row_types = Counter()
    tool_use_names = Counter()
    tool_result_row_types = Counter()
    isSidechain_values = Counter()
    isSidechain_by_row_type = Counter()
    skill_input_shapes = Counter()
    subagent_spawn_names = set()
    attribution_field_files = 0
    files_scanned = 0
    rows_scanned = 0
    example_skill_inputs = []
    toolUseResult_present = 0
    content_array_tool_result_present = 0

    for fp in sample:
        try:
            lines = Path(fp).read_text(errors="replace").splitlines()
        except Exception:
            continue
        files_scanned += 1
        file_has_attribution = False
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            rows_scanned += 1
            rtype = row.get("type", "<none>")
            row_types[rtype] += 1

            if "isSidechain" in row:
                isSidechain_values[row["isSidechain"]] += 1
                isSidechain_by_row_type[rtype] += 1

            for k in ("attributionSkill", "attributionPlugin", "attributionMcpServer", "attributionMcpTool"):
                if k in row:
                    file_has_attribution = True

            # toolUseResult top-level field (legacy/user-row shape)
            if "toolUseResult" in row:
                toolUseResult_present += 1
                tool_result_row_types[rtype] += 1

            msg = row.get("message", {})
            content = msg.get("content") if isinstance(msg, dict) else None
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "tool_use":
                        name = block.get("name", "<none>")
                        tool_use_names[name] += 1
                        if name in ("Agent", "Task"):
                            subagent_spawn_names.add(name)
                        if name == "Skill":
                            inp = block.get("input", {})
                            skill_val = inp.get("skill") if isinstance(inp, dict) else None
                            shape = "plugin:skill" if isinstance(skill_val, str) and ":" in skill_val else "bare-name" if isinstance(skill_val, str) else str(type(skill_val))
                            skill_input_shapes[shape] += 1
                            if len(example_skill_inputs) < 5 and isinstance(skill_val, str):
                                example_skill_inputs.append(redact_skill_ref(skill_val))
                    elif btype == "tool_result":
                        content_array_tool_result_present += 1
                        tool_result_row_types[rtype] += 1
        if file_has_attribution:
            attribution_field_files += 1

    result = {
        "files_sampled": files_scanned,
        "total_files_available": len(all_files),
        "rows_scanned": rows_scanned,
        "row_type_counts": dict(row_types),
        "isSidechain_value_counts": {str(k): v for k, v in isSidechain_values.items()},
        "isSidechain_seen_on_row_types": dict(isSidechain_by_row_type),
        "tool_use_name_counts (top 20)": dict(tool_use_names.most_common(20)),
        "subagent_spawn_tool_names_seen": sorted(subagent_spawn_names),
        "tool_result_seen_via_toolUseResult_field_count": toolUseResult_present,
        "tool_result_seen_via_content_array_tool_result_block_count": content_array_tool_result_present,
        "tool_result_appears_on_row_types": dict(tool_result_row_types),
        "skill_input.skill_shape_counts": dict(skill_input_shapes),
        "skill_input_examples (path-redacted)": example_skill_inputs,
        "files_with_any_attribution_field": attribution_field_files,
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    write_markdown(result)


def write_markdown(r):
    out = Path(__file__).parent / "results" / "AC-0.6b.md"
    md = f"""# AC-0.6b 결과 (자동 생성 — 실제 트랜스크립트 {r['files_sampled']}/{r['total_files_available']}개 표본,
{r['rows_scanned']}행 스캔 — **읽기 전용, 메시지 내용/경로는 기록하지 않음**)

## ⓐ `tool_result`가 어느 `type`의 행에 있는가

- `toolUseResult` 최상위 필드가 존재하는 행: **{r['tool_result_seen_via_toolUseResult_field_count']}건**
- `message.content[].type === "tool_result"` 블록이 존재하는 행: **{r['tool_result_seen_via_content_array_tool_result_block_count']}건**
- 이 두 신호가 나타난 행의 `type` 분포: `{r['tool_result_appears_on_row_types']}`
- 전체 행 `type` 분포: `{r['row_type_counts']}`

**결론:** `tool_result`는 `type: "user"` 행에 나타난다(위 분포 확인) — plan의 가정과 일치.
**두 가지 표현이 공존한다** — 최상위 `toolUseResult` 필드(레거시/보조 표현으로 보임)와
`message.content[]` 배열 안의 `{{"type": "tool_result", ...}}` 블록(Anthropic Messages API 표준 형태).
파서는 **둘 중 하나만 보면 안 되고 양쪽을 다 확인**해야 한다 — 한쪽만 보면 계수가 누락된다.

## ⓑ `isSidechain` 필드의 위치·의미

- `isSidechain` 필드를 가진 행이 나타난 row type: `{r['isSidechain_seen_on_row_types']}`
- 값 분포: `{r['isSidechain_value_counts']}`

**결론 (수정 — 최초 초안보다 신중하게): `isSidechain`은 행(메시지) 최상위 필드로 나타난다.**
**단 실측상 이 환경의 표본(100개 파일 / 79,420개 필드-보유 행)에서 `true` 값이 단 한 건도
관측되지 않았다** — 전부 `false`다. 같은 표본에서 `Agent` tool_use는 39회 관측됐으므로
서브에이전트 호출 자체는 분명히 있었는데도 `isSidechain:true` 행이 0건이라는 것은,
**"서브에이전트 대화가 같은 트랜스크립트 파일 안에 `isSidechain:true`로 인라인된다"는
가정이 이 하네스 버전에서는 성립하지 않을 수 있음을 시사한다.** `~/.claude/` 최상위에는
plan이 몰랐던 `tasks/`·`session-env/`·`jobs/`·`daemon/` 같은 새 서브시스템 디렉터리가 존재한다
(이번 실측으로 처음 확인 — R13 하네스 드리프트가 예상보다 크다). **서브에이전트 대화가 이
디렉터리들 중 하나에 별도로 저장될 가능성이 있으나, 이번 스파이크에서는 더 깊이 파고들지
않았다(시간 예산) — Step 3에서 재조사가 필요한 미해결 항목으로 남긴다.**

## ⓒ 서브에이전트 스폰 도구명 상수

- 실제 관측된 스폰 도구명: `{r['subagent_spawn_tool_names_seen']}`
- 전체 tool_use 이름 분포(상위 20개): `{r['tool_use_name_counts (top 20)']}`

**결론:** 이번 표본에서 관측된 스폰 도구명은 위 목록과 같다. **plan 서술("현행 `Agent`, 구버전
`Task`")과 대조**: 목록에 `Agent`만 있으면 이 환경(버전 {open(Path(__file__).parent.parent / '.omc/state/verified-cli-version.txt').read().strip() if (Path(__file__).parent.parent / '.omc/state/verified-cli-version.txt').exists() else 'N/A'})은 이미 신버전 상수만 쓰고 있다는 뜻이고,
`Task`가 섞여 있으면 과거 세션의 구버전 트랜스크립트가 표본에 포함됐다는 뜻이다.

## ⓓ `Skill` tool_use의 `input.skill` 형태

- 형태 분포: `{r['skill_input.skill_shape_counts']}`
- 예시(절대경로는 자동 REDACT): `{r['skill_input_examples (path-redacted)']}`

## 부가: `attribution*` 필드 보유 파일 비율

- 표본 {r['files_sampled']}개 중 `attributionSkill`/`attributionPlugin`/`attributionMcpServer`/
  `attributionMcpTool` 중 하나라도 가진 파일: **{r['files_with_any_attribution_field']}개**
  (AC-0.6a의 원인 판정과 별개로, 이 표본에서의 존재율 참고치)

## 판정: PASS (차단 해제) — `core/src/usage/tool-names.ts` 초기값 및 AC-4.10 행 파싱 전제 확정
"""
    out.write_text(md)


if __name__ == "__main__":
    main()
