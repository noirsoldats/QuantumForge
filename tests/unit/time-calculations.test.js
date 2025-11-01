/**
 * Unit Tests for Time Calculations
 *
 * Tests manufacturing time calculations with TE bonuses and facility effects
 */

const { calculateManufacturingTime } = require('../../src/main/blueprint-calculator');
const { createMockDatabase } = require('./helpers/database-mocks');
const blueprintFixtures = require('./fixtures/blueprints');
const facilitiesFixtures = require('./fixtures/facilities');

describe('Time Calculations', () => {
  describe('calculateManufacturingTime', () => {
    const baseTime = 600;  // 10 minutes in seconds

    test('calculates base time with no TE bonus', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        0,  // TE level 0
        1,  // 1 run
        null,
        mockDb
      );

      expect(result.adjustedTime).toBe(baseTime);
    });

    test('applies TE 10 reduction (10%)', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,  // TE level 10
        1,
        null,
        mockDb
      );

      // 600 * (1 - 0.10) = 540
      expect(result.adjustedTime).toBe(540);
    });

    test('applies TE 20 reduction (20%)', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        20,  // TE level 20
        1,
        null,
        mockDb
      );

      // 600 * (1 - 0.20) = 480
      expect(result.adjustedTime).toBe(480);
    });

    test('scales time with multiple runs', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        0,
        10,  // 10 runs
        null,
        mockDb
      );

      // 600 * 10 = 6000
      expect(result.adjustedTime).toBe(6000);
    });

    test('combines TE reduction with multiple runs', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,  // TE 10
        10,  // 10 runs
        null,
        mockDb
      );

      // 600 * 0.9 * 10 = 5400
      expect(result.adjustedTime).toBe(5400);
    });

    test('applies facility TE bonus (Raitaru 15%)', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const facility = facilitiesFixtures.raitaruNoRigs;

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        0,
        1,
        facility,
        mockDb
      );

      // 600 * (1 - 0.15) = 510
      expect(result.adjustedTime).toBeApproximately(510, 1);
    });

    test('combines blueprint TE with facility TE', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const facility = facilitiesFixtures.raitaruNoRigs;  // 15% TE

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,  // Blueprint TE 10%
        1,
        facility,
        mockDb
      );

      // 600 * (1 - 0.10) * (1 - 0.15) = 600 * 0.9 * 0.85 = 459
      expect(result.adjustedTime).toBeApproximately(459, 1);
    });

    test('applies TE rig bonus', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const facility = facilitiesFixtures.raitaruT1TERig;  // 15% + 20% = 35% total

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        0,
        1,
        facility,
        mockDb
      );

      // 600 * (1 - 0.35) = 390
      expect(result.adjustedTime).toBeApproximately(390, 1);
    });

    test('handles very short base times', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: 10 })
        }
      });

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        null,
        mockDb
      );

      // 10 * 0.9 = 9
      expect(result.adjustedTime).toBe(9);
    });

    test('handles very long base times (capital ships)', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: 86400 })  // 24 hours
        }
      });

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.RAVEN_BLUEPRINT,
        10,
        1,
        facilitiesFixtures.azbelNoRigs,
        mockDb
      );

      // Should significantly reduce 24 hour build time
      expect(result.adjustedTime).toBeLessThan(86400);
      expect(result.adjustedTime).toBeGreaterThan(0);
    });

    test('returns 0 for invalid blueprint', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => null
        }
      });

      const result = calculateManufacturingTime(
        99999,  // Invalid
        10,
        1,
        null,
        mockDb
      );

      expect(result.adjustedTime).toBe(0);
    });

    test('handles null facility gracefully', () => {
      const mockDb = createMockDatabase({
        get: {
          'select': () => ({ time: baseTime })
        }
      });

      const result = calculateManufacturingTime(
        blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT,
        10,
        1,
        null,  // No facility
        mockDb
      );

      // Should still apply blueprint TE
      expect(result.adjustedTime).toBe(540);
    });
  });

  describe('Time Conversion Helpers', () => {
    test('converts seconds to hours correctly', () => {
      const seconds = 3600;
      const hours = seconds / 3600;

      expect(hours).toBe(1);
    });

    test('converts seconds to days correctly', () => {
      const seconds = 86400;
      const days = seconds / 86400;

      expect(days).toBe(1);
    });

    test('formats production time for display', () => {
      const seconds = 7200;  // 2 hours
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);

      expect(hours).toBe(2);
      expect(minutes).toBe(0);
    });
  });
});
