import { describe, it, expect } from 'vitest';
import { scoreCompliance } from '../src/compliance/scoring/compliance-scoring.js';

describe('Dynamic Policy Profiles', () => {
  it('should override default weights with customWeights', () => {
    const findings = [{ ruleId: 'outOfZone', severity: 'medium', pageNumber: 1 }];
    const baseline = { findings };
    
    // Default score: medium = 1(severity multiplier) * 16(weight) = 16
    const resDefault = scoreCompliance({ baseline });
    expect(resDefault.findings[0].score).toBe(16);

    // Override score: medium = 1(severity multiplier) * 20(custom weight) = 20
    const customWeights = { outOfZone: 20 };
    const resCustom = scoreCompliance({ baseline, customWeights });
    expect(resCustom.findings[0].score).toBe(20);
  });
});
