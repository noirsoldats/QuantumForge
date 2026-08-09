# Manufacturing Plan IPC — actual return shapes

Recorded 2026-08-01 by reading `src/main/manufacturing-plans.js` and
`src/main/plan-matching.js` directly. **Verified, not assumed.**

This exists because the §3.6 view was written against invented field names.
Every IPC method existed, so wiring checks passed; the *shapes* were wrong, and
the test fixtures encoded the same invention — so 120 tests passed while the UI
showed `Type ######`, `NaN%` and blank columns.

**Before rendering any field, check it here.**

---

## Naming conventions that bite

1. **No IPC on this surface resolves type names.** Every list returns type IDs
   only. Names come from a separate `sde.getTypeNames(typeIds)` batch. Anything
   showing `Type ######` is a missing name lookup, not a backend gap.
2. **Quantity is `quantity`**, never `quantityNeeded`.
3. **Price is `basePrice`**, never `priceEach`. A plan-scoped override arrives
   separately as `planOverridePrice`; the effective price is
   `planOverridePrice ?? basePrice`.
4. **Matches nest their source object** (`job`, `transaction`) rather than
   flattening it.

---

## `plans.getMaterials(planId, includeAssets)`

```js
{
  typeId, quantity,               // NOT quantityNeeded
  basePrice,                      // NOT priceEach
  planOverridePrice,              // null unless a plan override exists
  priceFrozenAt,
  manuallyAcquired,               // 0 | 1
  manuallyAcquiredQuantity,
  acquisitionMethod,              // null when not acquired
  customPrice,                    // weighted average actually paid, or null
  acquisitionNote, acquisitionUpdatedAt,
  purchasedQuantity, purchaseMatchCount,
  manufacturedQuantity, manufacturingMatchCount,
  ownedPersonal, ownedCorp,       // 0 unless includeAssets
}
```

- **Effective price for display**: `planOverridePrice ?? basePrice`
- **Actual paid** (ledger-derived): `customPrice ?? basePrice`
- **Still needed**: `quantity - manuallyAcquiredQuantity - purchasedQuantity
  - manufacturedQuantity` (floored at 0)

## `plans.getProducts(planId)`

```js
{ typeId, quantity, basePrice, planOverridePrice, priceFrozenAt,
  isIntermediate, intermediateDepth }
```

Ordered intermediates-first. Only `isIntermediate === false` rows are revenue —
an intermediate is a cascading input the plan consumes.

## `plans.getBlueprints(planId)`

```js
{ planBlueprintId, planId, parentBlueprintId, blueprintTypeId,
  runs, lines, meLevel, teLevel,
  facilityId, facilitySnapshot,   // snapshot is parsed JSON or null
  useIntermediates,               // normalised to a string
  isIntermediate, isBuilt, builtRuns,
  intermediateProductTypeId, addedAt }
```

No `typeName`. Includes intermediates — the legacy view filters them out with
`plans.getAllIntermediates(planId)` and renders them as sub-rows.

## `plans.getReactions(planId)`

```js
{ planBlueprintId, planId, parentBlueprintId,
  reactionTypeId,                 // NOT blueprintTypeId
  reaction_type_id,               // raw column, also present
  runs, lines, facilityId, facilitySnapshot,
  isIntermediate, isBuilt, builtRuns,
  intermediateProductTypeId, useIntermediates, addedAt }
```

## `plans.getBuildItems(planId)`

```js
{ itemType, blueprintTypeId, typeName,   // typeName IS resolved here
  productTypeId, productName,
  role,                                   // blueprint | intermediate | reaction | sub-reaction
  instanceCount, totalRuns,
  runs, lines, runsEditable, topLevelPlanBlueprintId,
  meLevel, teLevel,                       // null for reactions
  useIntermediates, facilityId }
```

**The exception**: this one DOES resolve names. Collapsed fields return the
literal object `{ mixed: true }` when a type's instances disagree.

## `plans.getPendingMatches(planId)`

```js
{
  jobMatches: [{
    matchId, planId, planBlueprintId, confidence, matchReason, status,
    job: { jobId, installerId, facilityId, activityId, blueprintTypeId,
           runs, status, startDate, endDate, completedDate,
           characterId, characterName, isCorporation, corporationId },
    planBlueprint: { blueprintTypeId, runs, meLevel, teLevel },
  }],
  transactionMatches: [{
    matchId, planId, transactionId, typeId, matchType, quantity,
    confidence, matchReason, status,
    transaction: { transactionId, characterId, date, typeId, ... },
  }],
}
```

Job identity lives under `job`; the plan side under `planBlueprint`. Nothing is
flattened.

## `plans.getAnalytics(planId)`

```js
{
  progress: {
    jobs:      { completed, total, percent },
    materials: { purchased, total, percent },
    products:  { sold, total, percent },
    overall,
  },
  materialCosts: { planned, actual, delta, deltaPercent },
  productValue:  { planned, actual, delta, deltaPercent },
  profit:        { planned, actual, delta, deltaPercent },
}
```

## `plans.getLedger(planId)`

```js
{
  planId,
  categories: {
    materialPurchases: { items, total },
    productSales:      { items, total },
    jobInstallation:   { items, total, estimated },  // estimated flag!
    marketFees:        { items, total },
    other:             { items, total },
  },
  totals: { materialPurchases, productSales, jobInstallation,
            marketFees, other, totalSpend },
  reconciliation: { plannedCost, actualSpend, delta },
}
```

Entry rows carry `editable` — true only for manual rows (`source_type` null or
`'manual'`). Cost categories that reach `other`: `shipping`, `other`.
`marketFees` takes `broker_fee`, `sales_tax`, `job_tax`.

## `plans.getSummary(planId)`

```js
{ materialCost, materialsWithPrice, totalMaterials,
  jobInstallationCost, jobCount,
  productValue, productsWithPrice, totalProducts,
  estimatedProfit, roi }
```
