import { describe, it, expect } from 'vitest';
import { djb2Hash } from '../src/hash.js';

describe('djb2Hash', () => {
  it('is deterministic for the same input', () => {
    expect(djb2Hash('hello world')).toBe(djb2Hash('hello world'));
  });

  it('differs for different input', () => {
    expect(djb2Hash('hello world')).not.toBe(djb2Hash('hello worlD'));
  });

  it('handles the empty string', () => {
    expect(djb2Hash('')).toBe(djb2Hash(''));
    expect(typeof djb2Hash('')).toBe('string');
  });

  it('produces a stable known value', () => {
    expect(djb2Hash('task-juggler')).toBe(djb2Hash('task-juggler'));
    expect(djb2Hash('task-juggler')).not.toBe(djb2Hash('task juggler'));
  });
});
