/**
 * @fileoverview Unit tests for the shared station/comment renderers in `_station-schema.ts`.
 * These are pure functions feeding every tool's `format()` output, so they are pinned here
 * rather than only through a handler.
 * @module tests/tools/station-schema
 */

import { describe, expect, it } from 'vitest';
import { renderComment } from '@/mcp-server/tools/definitions/_station-schema.js';

describe('renderComment', () => {
  const URL = 'https://forum.example.it/t46938.html';

  it('renders an attached link once when the comment text already carries it', () => {
    const line = renderComment({
      user: 'driver',
      comment: `Great spot. Full review here: ${URL}`,
      relatedUrl: URL,
    });

    expect(line.split(URL)).toHaveLength(2); // exactly one occurrence
    expect(line).toBe(`driver: Great spot. Full review here: ${URL}`);
  });

  it('appends an attached link the comment text does not carry', () => {
    const line = renderComment({ user: 'driver', comment: 'Charger was dead.', relatedUrl: URL });

    expect(line).toBe(`driver: Charger was dead. ${URL}`);
  });

  it('renders an attached link with no comment text', () => {
    const line = renderComment({ user: 'driver', relatedUrl: URL });

    expect(line).toBe(`driver: ${URL}`);
  });

  it('leaves no dangling separator when there is neither text nor link', () => {
    const line = renderComment({ user: 'driver', checkinStatus: 'Charged Successfully' });

    expect(line).toBe('driver (Charged Successfully)');
    expect(line.endsWith(':')).toBe(false);
  });
});
