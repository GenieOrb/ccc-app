import { describe, expect, it } from 'vitest';
import { MECHANISM_FORMAT_MATRIX, MECHANISMS, FORMATS } from './planner';

describe('Planner Matrix', () => {
  it('todas las celdas existen y no hay undefined', () => {
    for (const mech of MECHANISMS) {
      for (const format of FORMATS) {
        const val = MECHANISM_FORMAT_MATRIX[mech.id][format.id];
        expect(val).toBeDefined();
        expect([0, 1, 2]).toContain(val);
      }
    }
  });

  it('debe haber incompatibilidades reales con valor 0', () => {
    let zeros = 0;
    for (const mech of MECHANISMS) {
      for (const format of FORMATS) {
        if (MECHANISM_FORMAT_MATRIX[mech.id][format.id] === 0) {
          zeros++;
        }
      }
    }
    expect(zeros).toBeGreaterThan(0);
  });
});
