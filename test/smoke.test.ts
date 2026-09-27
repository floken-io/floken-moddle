import { describe, it, expect } from 'vitest';
import { PACKAGE } from '../src/index';

describe('@floken/moddle smoke', () => {
  it('exposes package name', () => {
    expect(PACKAGE).toBe('@floken/moddle');
  });
});
