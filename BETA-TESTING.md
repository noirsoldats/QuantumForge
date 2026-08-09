# Quantum Forge Beta Testing

Thank you for testing. This build is a **beta** — it is not the stable release, and it
changes more at once than any previous update.

**Please read the rollback section before you install.** It is short, and it is the part
that matters if something goes wrong.

---

## What is in this beta

The entire user interface has been rebuilt around a persistent application shell:

- Every screen now lives inside one window with a sidebar, instead of a mix of pages and
  separate windows.
- Any tool can be **popped out** into its own window, keeping its current state — pop out the
  Blueprint Calculator mid-calculation and the results come with it.
- ESI rate limiting and caching were reworked to make far fewer API calls.
- Market refresh now shows real progress instead of appearing to hang.

Because the shell stores window sizes and positions differently, **this build migrates your
settings and databases on first launch.**

---

## Before you install: your data is backed up automatically

The first time this version starts, it copies your existing data **before** it migrates
anything:

| File | What it holds |
|---|---|
| `quantum_config.json` | All settings, characters, facilities, market sets |
| `character-data.db` | Manufacturing plans, industry jobs, wallet transactions |
| `esi-status.db` | ESI call history and rate-limit state |
| `market_data.sqlite.gz` | Market cache, watchlists, price overrides (compressed) |

They are written to a folder inside your Quantum Forge data directory:

- **Windows**: `%APPDATA%\Quantum Forge\backups\`
- **macOS**: `~/Library/Application Support/Quantum Forge/backups/`
- **Linux**: `~/.config/Quantum Forge/backups/`

**Your first backup will be called `pre-0.12`.** Earlier releases did not record which
version was running, so the beta cannot know you were on 0.11.0 — it labels the snapshot
`pre-0.12` instead. That folder is the one that restores you to your pre-beta state. Later
upgrades (beta 1 → beta 2, and so on) are named after the actual version they replaced.

Each folder also contains `backup-info.json` recording which version it came from and when.

**The backup is taken once per version.** Restarting the same build will not overwrite it,
so the copy stays as it was before migration.

**`pre-0.12` is kept permanently. Everything after it cycles.** Each backup is over 100 MB, so
as you move through beta builds the app keeps only the two most recent ones and deletes older
ones — but `pre-0.12` is never removed and never counts towards that limit. In practice you
will see three folders: `pre-0.12` plus your last two upgrades.

Folders you create yourself inside `backups/` are never touched, so if you want an extra copy
that is guaranteed to persist, just make one there.

---

## Installing

These builds are **not code-signed**, so your operating system will warn you. This is
expected and is not specific to the beta.

- **Windows** — download `Quantum-Forge-Setup-*.exe`. SmartScreen will show
  "Windows protected your PC": click **More info → Run anyway**.
- **macOS** — download `Quantum-Forge-*.dmg` (the universal build works on both Intel and
  Apple Silicon). Gatekeeper will say the app "cannot be opened because the developer cannot
  be verified": **right-click the app → Open**, then confirm. Double-clicking will not work
  the first time.
- **Linux** — download `Quantum-Forge-*.AppImage`, then
  `chmod +x Quantum-Forge-*.AppImage` and run it.

You do not need to uninstall your current version first.

---

## Rolling back to 0.11.0

> **Restoring the backup is required, not optional.**
>
> Reinstalling 0.11.0 on its own is **not** a rollback. The settings migration renames the
> window-state entries and **deletes the old names**, and 0.11.0 cannot read the new ones. It
> will start, but with your window layout reset — and the database schema will have moved on
> too.

1. **Quit Quantum Forge completely.**
2. Open your data directory (paths above) and go into `backups/pre-0.12/` — that is the
   snapshot taken just before the beta first migrated your data. (If you have been through
   several beta builds there will be other folders too; `pre-0.12` is the one that returns
   you to 0.11.0. Check `backup-info.json` if you are unsure.)
3. Uncompress the market cache:
   - **macOS / Linux**: `gunzip market_data.sqlite.gz`
   - **Windows**: extract it with [7-Zip](https://www.7-zip.org/) — right-click →
     7-Zip → Extract Here
4. Copy the files back over the live ones:
   - `quantum_config.json` → `config/quantum_config.json`
   - `character-data.db` → `config/character-data.db`
   - `market_data.sqlite` → `config/market_data.sqlite`
   - `esi-status.db` → the data directory root (**not** `config/`)
5. Uninstall the beta and reinstall
   [0.11.0](https://github.com/NoirSoldats/QuantumForge/releases/tag/v0.11.0).

Note that `esi-status.db` sits beside the `config/` folder, not inside it — the other three
go in `config/`.

---

## What to test

Ordinary use is the most valuable thing you can do. Beyond that, these areas are the ones
automated tests cannot reach:

**Startup and migration**
- Does the app start cleanly the first time, and again on the second launch?
- Are your characters, facilities, market sets and manufacturing plans all still there?
- Did a `backups/` folder appear, with four files in it?

**Pop-out windows** — the most state-sensitive part of the redesign
- Run a calculation in the **Blueprint Calculator**, then pop it out. The results should
  appear immediately, without recalculating.
- Do the same with **Manufacturing Plans**, **Reactions**, **Manufacturing Summary**,
  **What Can I Build** and **Loot Analyzer**.
- Close and reopen a popped-out window — does it return to the same size and position?

**Market**
- Run **Refresh All Markets** and watch the progress dialog. Does it reach 100%, and does it
  only appear in the window you started it from?
- Check that prices and watchlists survived the upgrade.

**Manufacturing Plans**
- Confirm locked plan prices did **not** change after a market refresh.
- Add a blueprint, edit ME/TE on the Build List tab, and confirm the values stick.

**Anything that looks wrong** — misaligned text, an unreadable colour, a button that does
nothing. The UI is new, so cosmetic reports are genuinely useful here.

---

## Reporting problems

Open an issue at
[github.com/NoirSoldats/QuantumForge/issues](https://github.com/NoirSoldats/QuantumForge/issues)
and include:

1. What you did, and what you expected instead.
2. Your operating system.
3. The version, from the app's Settings screen.
4. Your log file:
   - **Windows**: `%APPDATA%\Quantum Forge\logs\quantum-forge.log`
   - **macOS**: `~/Library/Application Support/Quantum Forge/logs/quantum-forge.log`
   - **Linux**: `~/.config/Quantum Forge/logs/quantum-forge.log`

Screenshots help a great deal for anything visual.

---

## When the stable release ships

You do **not** need to reinstall. This beta will offer you the `0.12.0` update automatically
when it is published, and installing it moves you back onto the normal release channel.
