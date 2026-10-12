import { describe, expect, it } from "vitest";
import { FAILURE_CLASSES, extractFailureClass, failureClassOf } from "../src/index.js";

// R7 Step 2 — 신규 5종은 두 독자 모두에서 등재 값으로 읽혀야 한다(등재가 곧 배선).
const R7_CLASSES = [
  "claude_json_format_unrecognized",
  "mcp_toggle_refused",
  "claude_json_post_write_unmeasured",
  "backup_failed",
  "journal_write_failed",
  "claude_json_write_failed",
] as const;

describe("failureClassOf / extractFailureClass", () => {
  it.each(R7_CLASSES)("%s는 등재되어 있고 두 독자가 그대로 돌려준다", (fc) => {
    expect(FAILURE_CLASSES).toContain(fc);
    expect(failureClassOf({ failureClass: fc })).toBe(fc);
    expect(extractFailureClass({ failureClass: fc })).toBe(fc);
  });

  it("미등재 문자열은 null / unclassified", () => {
    const err = { failureClass: "not_registered_anywhere" };
    expect(failureClassOf(err)).toBeNull();
    expect(extractFailureClass(err)).toBe("unclassified");
  });

  it.each([null, undefined, "failureClass", 42, { failureClass: 7 }, {}])("객체가 아니거나 필드가 없으면 null: %j", (err) => {
    expect(failureClassOf(err)).toBeNull();
    expect(extractFailureClass(err)).toBe("unclassified");
  });
});
