
## � 1. **Profit Velocity (ISK/Day or ISK/Week)**

**Formula:**
[
\text{Profit Velocity} = (\text{Average profit per unit}) \times (\text{Average units sold per day})
]

**Why it’s useful:**

* SVR tells you whether something sells quickly *relative to your output*, but not *how much ISK* that generates over time.
* Profit Velocity directly answers: *“How much can I realistically make per day if I keep selling this?”*
* Lets you sort items by daily cash flow rather than static profit margin.

---

## � 2. **Market Saturation Index (MSI)**

**Formula (simplified):**
[
\text{MSI} = \frac{\text{Total Sell Volume Listed}}{\text{Average Daily Sales Volume}}
]
or
[
\text{MSI} = \frac{\text{Sell Orders Volume (in units)}}{\text{Daily Sales Volume (in units)}}
]

**Interpretation:**

* High MSI → oversupply (stale market, long turnover).
* Low MSI → healthy demand (stock sells quickly).

**Use:**
Helps spot *bottlenecks* where your inventory might sit too long, even if SVR looks decent.

---

## � 3. **Price Momentum (Short vs. Long-Term Moving Averages)**

**Formula:**
[
\text{Momentum} = \frac{\text{MA}*{7d} - \text{MA}*{30d}}{\text{MA}_{30d}}
]

**Why it’s useful:**

* Tracks *short-term price trend direction* — are prices rising (momentum > 0) or falling?
* Combine with SVR to decide whether to *enter early* or *wait for correction*.
* Mimics real-world “technical analysis” metrics used in trading.

---

## � 4. **Turnover Time (Days to Liquidate Inventory)**

**Formula:**
[
\text{Turnover Time} = \frac{\text{Current Sell Order Volume}}{\text{Average Daily Sales Volume}}
]

**Why it’s useful:**

* Answers: *“If I list my production today, how long before it’s sold?”*
* Critical for managing cashflow and inventory cycles.
* Great complement to SVR when evaluating *long production runs* (ships, rigs, structures).

---

## � 5. **Profit Stability Index (PSI)**

**Formula:**
[
\text{PSI} = 1 - \frac{\text{Standard Deviation of Weekly Margin}}{\text{Average Weekly Margin}}
]

**Why it’s useful:**

* Measures how *volatile* profit margins are.
* A low PSI (unstable profits) suggests you might get undercut often or that input material prices are swinging.
* Useful for “set-and-forget” industrialists who prefer predictable, steady items.

---

## � 6. **Demand Growth Rate (DGR)**

**Formula:**
[
\text{DGR} = \frac{\text{Average daily sales last 7 days} - \text{Average daily sales previous 7 days}}{\text{Average daily sales previous 7 days}}
]

**Why it’s useful:**

* Shows whether demand is *accelerating or shrinking*.
* Useful for spotting new meta trends (e.g., new doctrines, balance changes, or events).

---

## ⚙️ 7. **Material Cost Volatility (MCV)**

**Formula:**
[
\text{MCV} = \frac{\text{σ(material adjusted prices)}}{\text{mean(material adjusted prices)}}
]

**Why it’s useful:**

* Tracks whether your *input costs* are stable.
* Helpful for risk management — even if final product margins are good, unstable input markets can make your costs spike suddenly.

---

## � 8. **Market Share Estimate (MSE)**

**Formula:**
[
\text{MSE} = \frac{\text{Your Sales Volume}}{\text{Total Market Volume}}
]

**Why it’s useful:**

* Estimates your dominance in a given market.
* Useful when scaling up — helps avoid saturating your own market share.

---

## � 9. **Weighted Margin Index (WMI)**

**Formula:**
[
\text{WMI} = \sum (\text{Margin per item} \times \text{Sales Volume Fraction})
]

**Why it’s useful:**

* For traders handling multiple SKUs, this gives a *portfolio-style* weighted profitability index.
* Helps identify which subset of items drives your total ISK.

---

### � Bonus: Combine Metrics into a “Market Health Score”

You could even design a composite score:
[
\text{Market Health} = 0.3 \times \text{SVR} + 0.3 \times \text{(1 - MSI)} + 0.2 \times \text{Momentum} + 0.2 \times \text{PSI}
]
That could be color-coded (green/yellow/red) to quickly flag “hot”, “risky”, or “oversaturated” items.
