import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('smoke', () => {
  it('should export VERSION', () => {
    expect(VERSION).toBe('0.0.1');
  });
});
