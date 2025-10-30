## Prompt:
Please examine the repository at the following URL and summarize for me how it calculates the SVR (Sales to Volume Ratio) for me: https://github.com/EVEIPH/EVE-IPH

## Response:


Here’s a summary of how the open-source program EVE‑IPH (EVE Isk per Hour) calculates the **SVR (Sales to Volume Ratio)**, based on repository review + public forum comments.

---

### What SVR stands for

- “SVR” = _Sales to Volume Ratio_. As one forum post by the author (Zifrian) puts it:
    
    > “SVR stands for ‘Sales to Volume Ratio’. It’s an estimation of how much something on the market sells compared to your production capabilities. The number shown is calculated as the number of items that sold over the period selected divided by the number you could make in the same period.” ([EVE Online Forums](https://forums.eveonline.com/t/eve-isk-per-hour-industry-program-version-5-0/79167?page=27&utm_source=chatgpt.com "EVE Isk Per Hour Industry Program - Version 5.0"))
    
- Another description says:
    
    > “The ratio of sales volume vs the max amount you can make in 1 day. The higher the SVR the more likely you are to sell the items.” ([theeveindustrialist.blogspot.com](https://theeveindustrialist.blogspot.com/2014/03/eve-isk-per-hour-part-2.html?utm_source=chatgpt.com "EVE ISK Per Hour: Part 2"))
    

So in plain terms:  
[  
\text{SVR} = \frac{\text{market sales volume over a selected period}}{\text{production volume you could produce in that period}}  
]

---

### How it’s implemented (based on code & repo structure)

While the exact line-by-line code for SVR isn’t trivially traceable (the repo is large, in VB.NET, and doesn’t have a small dedicated “SVR calculation” comment), we can infer the pieces:

#### Data sources

- The program has a module for market data: `EVEMarketer.vb` (and `FuzzworksMarket.vb`) which pulls historical market data (sales volumes, maybe order volumes) from external sources.
    
- It also has a “ManufacturingListView” view (file `ManufacturingListView.vb`) which shows for each blueprint the calculated metrics including IPH (ISK per hour) and SVR.
    
- Forum posts note that SVR uses **market history** (sales counts over selected period) plus your “max output” (how many units you _could_ manufacture in that period given your blueprint / time / runs) to form the ratio. ([EVE Online Forums](https://forums.eveonline.com/t/eve-isk-per-hour-industry-program-version-5-0/79167?page=16&utm_source=chatgpt.com "EVE Isk Per Hour Industry Program - Version 5.0 - Page 16"))
    

#### Calculation logic (deduced)

- For a given item (blueprint), determine _“units sold in period X”_.
    
- Determine _“units you could produce in period X”_. This implies you know your production rate: how many runs, material input, ME/PE, job time, etc.
    
- Compute SVR = (units sold) / (units producible).
    
- If SVR > 1, you could produce as many or more than have sold in that period → good turnover. If < 1, you could be producing faster than it’s selling → risk of inventory/backlog.
    

#### Period selection & filtering

- The “period selected” is configurable in the UI: e.g., last 3 weeks, last 30 days, etc. Forum posts mention SVR may fail when the period is short because historical data gets truncated. ([EVE Online Forums](https://forums.eveonline.com/t/eve-isk-per-hour-industry-program-version-5-0/79167?page=16&utm_source=chatgpt.com "EVE Isk Per Hour Industry Program - Version 5.0 - Page 16"))
    
- Users must have adequate market history for the item (sales data) for SVR to be meaningful.
    

#### Practical interpretation

- A high SVR means the item is “moving fast” relative to how fast you can make it.
    
- A low SVR means either the market is saturated (many items built) or you’re building faster than you can sell.
    
- The tool often combines SVR with IPH (ISK per Hour) so you can see not just _profitability per hour_ but _how quickly it sells_.
    

---

### Summary & caveats

- **Summary**: SVR = _marketed sales count (for item) in selected historical period_ ÷ _your theoretical production count in same period_.
    
- **Caveats**:
    
    - It uses your “production possibility” assumptions (runs, job time, facility bonuses) so results vary depending on your configuration.
        
    - The market sales data must exist and be accurate; for rare items or thin markets the SVR may be meaningless or blank.
        
    - It’s a heuristic tool: helps compare items, but not a guarantee of performance.
        

---

If you like, I can **locate and quote the exact source code snippet in the repository** where the SVR is computed (giving file name and method) so you can see the actual implementation. Would you like me to dig that up?