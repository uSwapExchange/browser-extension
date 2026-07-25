import { describe, expect, test } from 'bun:test';
import {
  releaseReplayRuleId,
  reserveReplayRuleId,
} from '../src/modules/peer-capture/capture/replay';

describe('capture replay rule allocation', () => {
  test('keeps concurrent replay rules distinct and re-usable', () => {
    const first = reserveReplayRuleId();
    const second = reserveReplayRuleId();
    expect(second).not.toBe(first);

    releaseReplayRuleId(first);
    releaseReplayRuleId(second);

    const next = reserveReplayRuleId();
    expect(next).toBeGreaterThanOrEqual(90_001);
    expect(next).toBeLessThanOrEqual(99_999);
    releaseReplayRuleId(next);
  });
});
