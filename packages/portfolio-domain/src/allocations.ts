import { addMinor } from './index';
import { allocationSettingsSchema, portfolioSnapshotSchema } from './schemas';
import type { AllocationSettings, AllocationScope } from './schemas';
import type { PortfolioSnapshot } from './index';
export interface HoldingAllocation {
  holdingId: string;
  actualMinor: number | null;
  actualBps: number | null;
  targetMinor: number | null;
  targetBps: number | null;
  deltaMinor: number | null;
  driftBps: number | null;
  fixed: boolean;
  excluded: boolean;
  warnings: string[];
}
export interface AllocationResult {
  scope: AllocationScope;
  actualTotalMinor: number;
  projectedTotalMinor: number;
  rows: HoldingAllocation[];
  warnings: string[];
  complete: false;
}
function ratio(value: number, total: number): number | null {
  if (total <= 0) return null;
  const result = Number((BigInt(value) * 10000n) / BigInt(total));
  return Number.isSafeInteger(result) ? result : null;
}
function portion(total: number, bps: number): number {
  return Number((BigInt(total) * BigInt(bps)) / 10000n);
}
/** Allocation is a balance comparison, never an aggregate or recomputed time-weighted return. */
export function calculateAllocations(
  snapshots: readonly PortfolioSnapshot[],
  settings: AllocationSettings,
): AllocationResult[] {
  const parsed = allocationSettingsSchema.parse(settings);
  const latest = new Map<string, PortfolioSnapshot>();
  for (const input of snapshots) {
    const snapshot = portfolioSnapshotSchema.parse(input);
    const key = JSON.stringify([snapshot.provenance.provider, snapshot.accountId]);
    const previous = latest.get(key);
    if (
      !previous ||
      Date.parse(previous.provenance.capturedAt) <= Date.parse(snapshot.provenance.capturedAt)
    )
      latest.set(key, snapshot);
  }
  return parsed.scopes.map((scope) => {
    const warnings = ['SOURCE_COVERAGE_UNKNOWN'];
    const accounts = [...latest.values()].filter(
      (snapshot) =>
        snapshot.accountId === scope.accountId &&
        (snapshot.accountType ?? 'unknown') === scope.accountType,
    );
    if (!accounts.length) warnings.push('ACCOUNT_SCOPE_NOT_LOADED');
    if (scope.accountType === 'unknown') warnings.push('ACCOUNT_TYPE_UNKNOWN');
    const holdings = accounts
      .flatMap((snapshot) => snapshot.holdings)
      .filter(
        (row) =>
          row.section === scope.section &&
          (!scope.holdingIds || scope.holdingIds.includes(row.id)) &&
          (!scope.goalId ||
            row.goalId === scope.goalId ||
            (accounts[0]?.provenance.provider === 'endowus' && row.code === scope.goalId)) &&
          (!row.valuation || row.valuation.currency === scope.currency),
      );
    if (new Set(holdings.map((row) => row.id)).size !== holdings.length)
      throw new TypeError('Duplicate holding identity in allocation scope');
    const included = holdings.filter(
      (row) => !(Object.hasOwn(scope.targets, row.id) && scope.targets[row.id]?.excluded),
    );
    const unknown = included.some((row) => !row.valuation);
    if (unknown) warnings.push('UNKNOWN_VALUATION_DENOMINATOR');
    for (const id of Object.keys(scope.targets))
      if (!holdings.some((row) => row.id === id)) warnings.push(`TARGET_HOLDING_NOT_LOADED:${id}`);
    const actualTotalMinor = included.reduce(
      (sum, row) => addMinor(sum, row.valuation?.minor ?? 0),
      0,
    );
    const projectedTotalMinor = addMinor(actualTotalMinor, scope.projectedDeposit?.minor ?? 0);
    if (actualTotalMinor <= 0) warnings.push('NON_POSITIVE_ALLOCATION_TOTAL');
    const rows = holdings.map((row) => {
      const target = Object.hasOwn(scope.targets, row.id) ? scope.targets[row.id] : undefined;
      const fixed = Boolean(target?.fixed),
        excluded = Boolean(target?.excluded),
        actualMinor = row.valuation?.minor ?? null;
      const actualBps =
        !unknown && !excluded && actualMinor !== null ? ratio(actualMinor, actualTotalMinor) : null;
      const targetMinor = excluded
        ? null
        : fixed
          ? actualMinor
          : target && 'targetAmount' in target
            ? target.targetAmount.minor
            : target && 'targetBps' in target && !unknown
              ? portion(projectedTotalMinor, target.targetBps)
              : null;
      const targetBps =
        target && 'targetBps' in target && !fixed && !excluded
          ? target.targetBps
          : targetMinor !== null && !unknown
            ? ratio(targetMinor, projectedTotalMinor)
            : null;
      return {
        holdingId: row.id,
        actualMinor,
        actualBps,
        targetMinor,
        targetBps,
        deltaMinor:
          targetMinor !== null && actualMinor !== null ? addMinor(targetMinor, -actualMinor) : null,
        driftBps: actualBps !== null && targetBps !== null ? actualBps - targetBps : null,
        fixed,
        excluded,
        warnings: actualMinor === null ? ['UNKNOWN_VALUATION'] : [],
      };
    });
    const targetTotal = rows.reduce((sum, row) => addMinor(sum, row.targetMinor ?? 0), 0);
    if (targetTotal > projectedTotalMinor) warnings.push('TARGET_TOTAL_EXCEEDS_PROJECTED_BALANCE');
    return {
      scope,
      actualTotalMinor,
      projectedTotalMinor,
      rows,
      warnings,
      complete: false as const,
    };
  });
}
