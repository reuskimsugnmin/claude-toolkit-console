/** 웹 콘솔의 "마지막 스캔 N일 전" 경고 (스펙 Constraints "신선도 보완"). */
export interface FreshnessResult {
  is_stale: boolean;
  days_since_last_scan: number;
}

export function computeFreshness(
  lastScanAt: Date,
  now: Date = new Date(),
  staleAfterDays = 7,
): FreshnessResult {
  const ms = now.getTime() - lastScanAt.getTime();
  const days = ms / (1000 * 60 * 60 * 24);
  return { is_stale: days > staleAfterDays, days_since_last_scan: Math.floor(days) };
}
