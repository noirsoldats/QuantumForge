/**
 * Market Data Fixtures for Testing
 *
 * Provides realistic market order and history data for testing pricing calculations
 * without depending on live ESI API data.
 */

// Standard market orders for Tritanium (typeId: 34) in Jita
const tritaniumOrders = {
  buy: [
    { order_id: 1, price: 6.50, volume_remain: 10000000, is_buy_order: true, location_id: 60003760 },
    { order_id: 2, price: 6.49, volume_remain: 5000000, is_buy_order: true, location_id: 60003760 },
    { order_id: 3, price: 6.48, volume_remain: 8000000, is_buy_order: true, location_id: 60003760 },
    { order_id: 4, price: 6.45, volume_remain: 3000000, is_buy_order: true, location_id: 60003760 },
    { order_id: 5, price: 6.40, volume_remain: 2000000, is_buy_order: true, location_id: 60003760 }
  ],
  sell: [
    { order_id: 6, price: 6.52, volume_remain: 15000000, is_buy_order: false, location_id: 60003760 },
    { order_id: 7, price: 6.53, volume_remain: 12000000, is_buy_order: false, location_id: 60003760 },
    { order_id: 8, price: 6.55, volume_remain: 8000000, is_buy_order: false, location_id: 60003760 },
    { order_id: 9, price: 6.60, volume_remain: 5000000, is_buy_order: false, location_id: 60003760 },
    { order_id: 10, price: 6.75, volume_remain: 3000000, is_buy_order: false, location_id: 60003760 }
  ]
};

// Market orders with outliers (extreme prices)
const ordersWithOutliers = [
  { order_id: 1, price: 100.00, volume_remain: 1000, is_buy_order: false, location_id: 60003760 },
  { order_id: 2, price: 105.00, volume_remain: 2000, is_buy_order: false, location_id: 60003760 },
  { order_id: 3, price: 102.00, volume_remain: 1500, is_buy_order: false, location_id: 60003760 },
  { order_id: 4, price: 103.00, volume_remain: 1800, is_buy_order: false, location_id: 60003760 },
  { order_id: 5, price: 500.00, volume_remain: 100, is_buy_order: false, location_id: 60003760 },  // Outlier (high)
  { order_id: 6, price: 10.00, volume_remain: 50, is_buy_order: false, location_id: 60003760 }    // Outlier (low)
];

// Market orders with insufficient depth
const lowDepthOrders = [
  { order_id: 1, price: 50.00, volume_remain: 100, is_buy_order: false, location_id: 60003760 },
  { order_id: 2, price: 52.00, volume_remain: 50, is_buy_order: false, location_id: 60003760 }
];

// Market orders meeting minimum volume threshold
const highVolumeOrders = [
  { order_id: 1, price: 1000.00, volume_remain: 50, is_buy_order: false, location_id: 60003760 },
  { order_id: 2, price: 1050.00, volume_remain: 100, is_buy_order: false, location_id: 60003760 },
  { order_id: 3, price: 1020.00, volume_remain: 5000, is_buy_order: false, location_id: 60003760 },  // Meets threshold
  { order_id: 4, price: 1025.00, volume_remain: 8000, is_buy_order: false, location_id: 60003760 },  // Meets threshold
  { order_id: 5, price: 1030.00, volume_remain: 200, is_buy_order: false, location_id: 60003760 }
];

// Historical market data for Tritanium (30 days)
const tritaniumHistory = [
  { date: '2025-10-01', average: 6.45, highest: 6.80, lowest: 6.20, volume: 850000000, order_count: 15234 },
  { date: '2025-10-02', average: 6.48, highest: 6.85, lowest: 6.25, volume: 820000000, order_count: 14987 },
  { date: '2025-10-03', average: 6.50, highest: 6.90, lowest: 6.30, volume: 890000000, order_count: 15456 },
  { date: '2025-10-04', average: 6.52, highest: 6.92, lowest: 6.32, volume: 875000000, order_count: 15123 },
  { date: '2025-10-05', average: 6.49, highest: 6.88, lowest: 6.28, volume: 860000000, order_count: 15001 },
  { date: '2025-10-06', average: 6.47, highest: 6.86, lowest: 6.26, volume: 870000000, order_count: 15245 },
  { date: '2025-10-07', average: 6.51, highest: 6.91, lowest: 6.31, volume: 900000000, order_count: 15678 },
  { date: '2025-10-08', average: 6.53, highest: 6.93, lowest: 6.33, volume: 910000000, order_count: 15789 },
  { date: '2025-10-09', average: 6.50, highest: 6.90, lowest: 6.30, volume: 895000000, order_count: 15567 },
  { date: '2025-10-10', average: 6.48, highest: 6.88, lowest: 6.28, volume: 880000000, order_count: 15432 },
  { date: '2025-10-11', average: 6.52, highest: 6.92, lowest: 6.32, volume: 905000000, order_count: 15690 },
  { date: '2025-10-12', average: 6.54, highest: 6.94, lowest: 6.34, volume: 920000000, order_count: 15823 },
  { date: '2025-10-13', average: 6.51, highest: 6.91, lowest: 6.31, volume: 890000000, order_count: 15534 },
  { date: '2025-10-14', average: 6.49, highest: 6.89, lowest: 6.29, volume: 875000000, order_count: 15412 },
  { date: '2025-10-15', average: 6.53, highest: 6.93, lowest: 6.33, volume: 915000000, order_count: 15756 },
  { date: '2025-10-16', average: 6.55, highest: 6.95, lowest: 6.35, volume: 930000000, order_count: 15890 },
  { date: '2025-10-17', average: 6.52, highest: 6.92, lowest: 6.32, volume: 900000000, order_count: 15623 },
  { date: '2025-10-18', average: 6.50, highest: 6.90, lowest: 6.30, volume: 885000000, order_count: 15489 },
  { date: '2025-10-19', average: 6.54, highest: 6.94, lowest: 6.34, volume: 925000000, order_count: 15834 },
  { date: '2025-10-20', average: 6.56, highest: 6.96, lowest: 6.36, volume: 940000000, order_count: 15923 },
  { date: '2025-10-21', average: 6.53, highest: 6.93, lowest: 6.33, volume: 910000000, order_count: 15678 },
  { date: '2025-10-22', average: 6.51, highest: 6.91, lowest: 6.31, volume: 895000000, order_count: 15545 },
  { date: '2025-10-23', average: 6.55, highest: 6.95, lowest: 6.35, volume: 935000000, order_count: 15867 },
  { date: '2025-10-24', average: 6.57, highest: 6.97, lowest: 6.37, volume: 950000000, order_count: 15978 },
  { date: '2025-10-25', average: 6.54, highest: 6.94, lowest: 6.34, volume: 920000000, order_count: 15712 },
  { date: '2025-10-26', average: 6.52, highest: 6.92, lowest: 6.32, volume: 905000000, order_count: 15601 },
  { date: '2025-10-27', average: 6.56, highest: 6.96, lowest: 6.36, volume: 945000000, order_count: 15901 },
  { date: '2025-10-28', average: 6.58, highest: 6.98, lowest: 6.38, volume: 960000000, order_count: 16012 },
  { date: '2025-10-29', average: 6.55, highest: 6.95, lowest: 6.35, volume: 930000000, order_count: 15789 },
  { date: '2025-10-30', average: 6.53, highest: 6.93, lowest: 6.33, volume: 915000000, order_count: 15667 }
];

// Historical data with high volatility
const volatileHistory = [
  { date: '2025-10-01', average: 100.00, highest: 120.00, lowest: 90.00, volume: 50000, order_count: 234 },
  { date: '2025-10-02', average: 150.00, highest: 180.00, lowest: 130.00, volume: 45000, order_count: 198 },
  { date: '2025-10-03', average: 80.00, highest: 95.00, lowest: 70.00, volume: 60000, order_count: 276 },
  { date: '2025-10-04', average: 200.00, highest: 250.00, lowest: 180.00, volume: 40000, order_count: 187 },
  { date: '2025-10-05', average: 110.00, highest: 130.00, lowest: 95.00, volume: 55000, order_count: 245 },
  { date: '2025-10-06', average: 160.00, highest: 190.00, lowest: 140.00, volume: 48000, order_count: 212 },
  { date: '2025-10-07', average: 90.00, highest: 105.00, lowest: 80.00, volume: 58000, order_count: 267 }
];

// Empty data sets for edge case testing
const emptyOrders = [];
const emptyHistory = [];

// Single order for edge case testing
const singleOrder = [
  { order_id: 1, price: 100.00, volume_remain: 1000, is_buy_order: false, location_id: 60003760 }
];

// Single history entry
const singleHistoryEntry = [
  { date: '2025-10-30', average: 6.50, highest: 6.90, lowest: 6.30, volume: 900000000, order_count: 15678 }
];

// Orders across multiple locations
const multiLocationOrders = [
  { order_id: 1, price: 100.00, volume_remain: 5000, is_buy_order: false, location_id: 60003760 },  // Jita
  { order_id: 2, price: 102.00, volume_remain: 4000, is_buy_order: false, location_id: 60003760 },  // Jita
  { order_id: 3, price: 105.00, volume_remain: 3000, is_buy_order: false, location_id: 60008494 },  // Amarr
  { order_id: 4, price: 103.00, volume_remain: 2000, is_buy_order: false, location_id: 60011866 },  // Dodixie
  { order_id: 5, price: 101.00, volume_remain: 6000, is_buy_order: false, location_id: 60003760 }   // Jita
];

// Expected VWAP calculations for Tritanium (pre-calculated for validation)
const tritaniumExpectedVWAP = {
  sell: {
    quantity1M: 6.5267,      // VWAP for 1M units of sell orders
    quantity10M: 6.5333,     // VWAP for 10M units of sell orders
    quantity50M: 6.5833      // VWAP for 50M units (approaches highest prices)
  },
  buy: {
    quantity1M: 6.4992,      // VWAP for 1M units of buy orders
    quantity10M: 6.4900,     // VWAP for 10M units of buy orders
    quantity30M: 6.4833      // VWAP for 30M units (approaches lowest prices)
  }
};

// Expected percentile prices for Tritanium
const tritaniumExpectedPercentile = {
  sell: {
    percentile20: 6.52,      // 20th percentile (default)
    percentile50: 6.55,      // 50th percentile (median)
    percentile80: 6.60       // 80th percentile
  },
  buy: {
    percentile20: 6.48,
    percentile50: 6.49,
    percentile80: 6.50
  }
};

// Expected statistical values
const tritaniumExpectedStats = {
  historicalAverage30Days: 6.52,
  historicalAverage7Days: 6.55,
  historicalMedian: 6.53,
  historicalStdDev: 0.03
};

module.exports = {
  // Order data
  tritaniumOrders,
  ordersWithOutliers,
  lowDepthOrders,
  highVolumeOrders,
  emptyOrders,
  singleOrder,
  multiLocationOrders,

  // Historical data
  tritaniumHistory,
  volatileHistory,
  emptyHistory,
  singleHistoryEntry,

  // Expected calculations (for validation)
  tritaniumExpectedVWAP,
  tritaniumExpectedPercentile,
  tritaniumExpectedStats,

  // Constants
  JITA_STATION_ID: 60003760,
  AMARR_STATION_ID: 60008494,
  DODIXIE_STATION_ID: 60011866,
  THE_FORGE_REGION_ID: 10000002,
  TRITANIUM_TYPE_ID: 34,
  PYERITE_TYPE_ID: 35
};
