import { describe, expect, it } from 'vitest';
import { EarlyCaptureQueue, EndowusJoin } from './capture-state';
const event = (path: string, time = '2026-10-04T00:00:00Z', goal = 'goal') => ({
  path,
  capturedAt: time,
  startedAt: time,
  route: '/dashboard',
  payload: [{ goalId: goal }],
});
describe('startup capture and coherent Endowus joins', () => {
  it('bounds the initial in-memory capture queue', () => {
    const queue = new EarlyCaptureQueue(() => 0);
    for (let index = 0; index < 20; index++) queue.push({ ...event('/v1/goals'), payload: index });
    expect(queue.take().map((x) => x.payload)).toEqual([14, 15, 16, 17, 18, 19]);
  });
  it('replays initial requests after prompt unlock, but expires/discards on lock', () => {
    let now = 0;
    const queue = new EarlyCaptureQueue(() => now);
    const first = event('/v1/goals');
    queue.push(first);
    expect(queue.take()).toEqual([first]);
    queue.push(first);
    expect(queue.take()).toEqual([]);
    const expired = new EarlyCaptureQueue(() => now);
    expired.push(first);
    now = 31_000;
    expect(expired.take()).toEqual([]);
  });
  it('never joins old components, mismatched account contexts, or old routes with new captures', () => {
    const join = new EndowusJoin();
    join.add(event('/v1/goals/performance'));
    join.add(event('/v2/goals/investible'));
    expect(join.add(event('/v1/goals', '2026-10-04T00:01:00Z'))).toBeUndefined();
    join.clear();
    join.add({ ...event('/v1/goals/performance'), accountContext: 'account-a' });
    join.add({ ...event('/v2/goals/investible'), accountContext: 'account-b' });
    expect(join.add({ ...event('/v1/goals'), accountContext: 'account-a' })).toBeUndefined();
    join.clear();
    join.add(event('/v1/goals/performance'));
    join.add({ ...event('/v2/goals/investible'), route: '/other' });
    expect(join.add(event('/v1/goals'))).toBeUndefined();
    join.clear();
  });
  it('allows out-of-order union/subsets and flags missing components without relabelling timestamps', () => {
    const join = new EndowusJoin();
    join.add({
      ...event('/v1/goals', '2026-10-04T00:00:04Z'),
      payload: [{ goalId: 'a' }, { goalId: 'b' }],
    });
    join.add({
      ...event('/v2/goals/investible', '2026-10-04T00:00:02Z'),
      payload: [{ goalId: 'b' }, { goalId: 'c' }],
    });
    const joined = join.add({ ...event('/v1/goals/performance'), payload: [{ goalId: 'a' }] });
    expect(joined?.incomplete).toBe(true);
    expect(joined?.capturedAt).toBe('2026-10-04T00:00:00Z');
    expect(joined?.input.investible).toEqual([{ goalId: 'b' }, { goalId: 'c' }]);
  });
  it('uses the oldest actual component timestamp, not a fresh label for old data', () => {
    const join = new EndowusJoin();
    join.add(event('/v1/goals/performance'));
    join.add(event('/v2/goals/investible', '2026-10-04T00:00:03Z'));
    expect(join.add(event('/v1/goals', '2026-10-04T00:00:04Z'))?.capturedAt).toBe(
      '2026-10-04T00:00:00Z',
    );
  });
});
