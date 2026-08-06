/**
 * @fileoverview Tests for reliability caveats derived from OCM station facts and comments.
 * @module tests/services/attribution.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReliabilityNote } from '@/services/openchargemap/attribution.js';

afterEach(() => {
  vi.useRealTimers();
});

const freshDate = '2026-07-15T00:00:00Z';

describe('buildReliabilityNote', () => {
  it('flags explicitly non-operational stations', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Not Operational',
        isOperational: false,
        dateLastVerified: freshDate,
        comments: [],
      }),
    ).toContain('not operational');
  });

  it('flags stale operational claims with the verification age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    const note = buildReliabilityNote({
      status: 'Operational',
      isOperational: true,
      dateLastVerified: '2024-01-01T00:00:00Z',
      comments: [],
    });
    expect(note).toMatch(/Last verified \d+ months ago/);
    expect(note).toContain('flag may be out of date');
  });

  it('flags missing verification dates without inventing an age', () => {
    expect(
      buildReliabilityNote({
        status: 'Operational',
        isOperational: true,
        dateLastVerified: null,
        comments: [],
      }),
    ).toBe('Listing has never been verified.');
  });

  it('always flags the 0,0 coordinate sentinel', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Operational',
        isOperational: true,
        dateLastVerified: freshDate,
        comments: [],
        coordinates: { latitude: 0, longitude: 0 },
      }),
    ).toContain('placeholder');
  });

  it('does not flag a real single-axis-zero coordinate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Operational',
        isOperational: true,
        dateLastVerified: freshDate,
        comments: [],
        coordinates: { latitude: 0, longitude: 32.58 },
      }),
    ).toBeUndefined();
  });

  it('counts fault-like comment types without counting positive comments', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Operational',
        isOperational: true,
        dateLastVerified: freshDate,
        comments: [
          { commentType: 'General Comment', comment: 'Worked' },
          { commentType: 'Fault Report', comment: 'Broken connector' },
          { commentType: 'Problem report', comment: 'Would not start' },
        ],
      }),
    ).toContain('2 of 3');
  });

  it('suppresses a lone fresh unknown-state caveat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Unknown',
        isOperational: undefined,
        dateLastVerified: freshDate,
        comments: [],
      }),
    ).toBeUndefined();
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('flags a fresh Temporarily Unavailable station despite IsOperational=true', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    const note = buildReliabilityNote({
      status: 'Temporarily Unavailable',
      statusTypeId: 30,
      isOperational: true,
      dateLastVerified: freshDate,
      comments: [],
    });
    expect(note).toContain('Temporarily Unavailable');
    expect(note).toContain('not usable right now');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('flags a partly-operational station as only partly working', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Partly Operational (Mixed)',
        statusTypeId: 75,
        isOperational: true,
        dateLastVerified: freshDate,
        comments: [],
      }),
    ).toContain('only some equipment here is working');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('drops the stale-flag caveat when the status already says the station is down', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    const note = buildReliabilityNote({
      status: 'Temporarily Unavailable',
      statusTypeId: 30,
      isOperational: true,
      dateLastVerified: '2024-01-01T00:00:00Z',
      comments: [],
    });
    expect(note).toMatch(/Last verified \d+ months ago\./);
    expect(note).not.toContain('flag may be out of date');
  });

  it('leaves every other status reading off the operational flag', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Operational',
        statusTypeId: 50,
        isOperational: true,
        dateLastVerified: freshDate,
        comments: [],
      }),
    ).toBeUndefined();
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('counts a negative check-in outcome even when its comment type is general', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    const note = buildReliabilityNote({
      status: 'Operational',
      isOperational: true,
      dateLastVerified: freshDate,
      comments: [{ commentType: 'General Comment', checkinStatusIsPositive: false }],
    });
    expect(note).toContain('1 of 1');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('counts a fault report and a negative check-in as separate signals', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Operational',
        isOperational: true,
        dateLastVerified: freshDate,
        comments: [
          // Fault-report type carrying a positive check-in — still a reported problem.
          { commentType: 'Fault Report', checkinStatusIsPositive: true },
          { commentType: 'General Comment', checkinStatusIsPositive: false },
          { commentType: 'General Comment', checkinStatusIsPositive: true },
        ],
      }),
    ).toContain('2 of 3');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('does not count a check-in OCM classifies as neither positive nor negative', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    expect(
      buildReliabilityNote({
        status: 'Operational',
        isOperational: true,
        dateLastVerified: freshDate,
        // "Did Not Visit Location" carries IsPositive: null, so no polarity comes across.
        comments: [{ commentType: 'General Comment', checkinStatus: 'Did Not Visit Location' }],
      }),
    ).toBeUndefined();
  });
});
