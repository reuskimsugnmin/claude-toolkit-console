import { z } from "zod";

/**
 * `claude auth status --json` 출력 — Step 4 실측(docs/harness-facts.md "claude auth status").
 * **개인식별정보(email·orgId·orgName)를 포함하는 실제 출력**이므로 `loggedIn`만 강제 검증하고
 * 나머지는 `.passthrough()`로 흘려보낸다 — `.strict()`를 쓰지 않는 이유는 R13(하네스 드리프트)
 * 때문이 아니라, **호출부가 그 필드들을 절대 읽지 않게 스키마 차원에서 좁히기 위해서다**
 * (읽지 않을 것이므로 존재를 몰라도 되고, 강제 검증하면 실수로 그 필드를 로그에 옮기는 코드가
 * 생길 위험만 늘어난다).
 */
export const AuthStatusSchema = z
  .object({
    loggedIn: z.boolean(),
  })
  .passthrough();

export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export function parseAuthStatus(data: unknown): AuthStatus {
  return AuthStatusSchema.parse(data);
}
