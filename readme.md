# ZyncSwap — Smart Contract Developer Assessment


### A note on forking

Forking was disabled on the original assessment repository, so instead of a
GitHub "fork" I cloned the repo locally and pushed the full history to a new
repository under my own account (`git remote set-url origin <my-repo>` +
`git push -u origin main`). The commit history from the original repo is
preserved. Happy to switch to a proper fork if forking gets re-enabled.



All 29 tests pass on a clean checkout (13 for `ZyncToken`, 16 for `ZyncVesting`).


To deploy "ZyncVesting" against a running local chain:

```bash
# with ZYNC_TOKEN_ADDRESS set in .env from the deploy step above
npx hardhat run contracts/scripts/deploy-vesting.cjs --network localhost --config contracts/hardhat.config.cjs
```

### What I changed

**Task 1 — Bug fix**
`setMintPrice` was checking the *current* price instead of the *incoming*
one, so `setMintPrice(0)` never reverted and permanently bricked
`mintWithEth`. Fixed by validating `newPriceWei` and added a custom error
`ZeroMintPrice`. Also added tests confirming the ETH refund logic in
`mintWithEth` already worked correctly for non-exact multiples of the mint
price — I initially assumed it rounded to whole tokens, but it actually
mints proportionally and only refunds when integer division truncates, so
I adjusted the test to use a price that forces truncation instead of
changing the contract.

**Task 2 — Burn**
Added `burn` and `burnFrom` (via the standard ERC-20 allowance flow) plus a
`Burned` event. The trickier part was the cap: the original cap check used
`totalSupply() + amount > MAX_SUPPLY`, but `totalSupply()` drops when
tokens are burned, which would have let someone mint, burn, and mint again
past the intended 1B cap indefinitely. I added a `totalMinted` counter that
only ever increases and used that for the cap check instead.

**Task 3 — Events**
Added `MintPriceUpdated`, `TreasuryMint`, and `Withdrawn`, each with
indexed parameters, and tests asserting the exact event args.

**Task 4 — ZyncVesting**
New contract. Design decisions:
- One vesting schedule per beneficiary (no overlapping schedules) — kept
  scope manageable given the time budget.
- Admin funds the contract first via `fund()`, then allocates from that
  balance with `createVestingSchedule`. This means a schedule can never be
  created for more tokens than the contract actually holds unallocated.
- Standard linear vesting: nothing before the cliff, then vests linearly
  from `start` to `start + duration`.
- Follows checks-effects-interactions in `release()` (state updated before
  the token transfer) plus `nonReentrant`, so double-claiming isn't
  possible even if the token had a malicious hook.

### Known limitations / what I'd improve with more time

- Only one active schedule per beneficiary. A production version would
  probably support multiple schedules per address (e.g. an array or a
  schedule ID) for cases like multiple grants over time.
- No schedule revocation/admin cancel function — some vesting designs let
  the admin revoke unvested tokens (e.g. for employee departures). Didn't
  add it since it wasn't in the spec, but it's a natural next step.
- No batch operations (e.g. `createVestingSchedule` for many beneficiaries
  in one tx) — would help with gas costs for larger token distributions.
- Test coverage uses `evm_setNextBlockTimestamp` to test specific points in
  the vesting curve; a fuzz/property-based test (e.g. with Foundry or
  hardhat-based fuzzing) would give broader confidence across random
  start/cliff/duration/timestamp combinations.

  **NOTE**
`ZyncVesting` was done with the help of artificial intelligence. 
