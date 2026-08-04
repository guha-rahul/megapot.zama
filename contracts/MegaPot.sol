// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITokenMessengerV2} from "./bridge/ICCTP.sol";
import {IConfidentialWrapper} from "./token/IConfidentialWrapper.sol";
import {IYieldSource} from "./yield/IYieldSource.sol";

/// @title  MegaPot
/// @notice A **confidential no-loss lottery** — PoolTogether, encrypted end to end with the
///         Zama Protocol (FHEVM).
///
///         Depositors put a confidential token (cUSDC, an ERC-7984 wrapper around USDC) into a
///         shared pool. The pooled principal is deployed to a yield source; the *yield* — and
///         only the yield — is the prize. Periodic draws award the whole prize to exactly one
///         depositor, with probability proportional to their stake. Nobody ever loses principal:
///         a non-winner simply keeps what they put in.
///
///         Everything about an individual is encrypted on-chain:
///
///         | Quantity                    | Visibility                                          |
///         | --------------------------- | --------------------------------------------------- |
///         | Your deposit amount         | 🔒 encrypted (`externalEuint64` + ERC-7984 transfer) |
///         | Your pool balance           | 🔒 encrypted (`euint64`, decryptable only by you)    |
///         | Your odds (ticket range)    | 🔒 encrypted                                        |
///         | The winning ticket          | 🔒 encrypted                                        |
///         | Who won / how much they won | 🔒 encrypted — the credit is `select(hit, prize, 0)` |
///         | Your withdrawal amount      | 🔒 encrypted (paid out in cUSDC from the buffer)     |
///         | Pool-wide totals, prize     | 🔓 public — see "the honest boundary" below          |
///
/// @dev    ## The ticket space
///
///         Odds are proportional to stake, resolved in **O(1)** — there is no per-depositor loop
///         anywhere in a draw or a claim.
///
///         The pool maintains one *encrypted cursor* over a global ticket space. A deposit of
///         `a` claims the half-open range `[cursor, cursor + a)` and advances the cursor by `a`.
///         Because the cursor is encrypted, an individual deposit never moves a public number —
///         only the cursor's running total is ever revealed, once per round, when entries close
///         (`closeEntries` → `finalizeEntries`). Individual amounts stay hidden inside that
///         aggregate.
///
///         A draw picks an encrypted ticket uniformly in `[0, totalTickets)`. A depositor claims
///         by proving, homomorphically, that the ticket falls inside one of their own ranges:
///
///             hit    = (lower <= ticket) && (ticket < upper)
///             award  = select(hit, unclaimedPrize, 0)
///
///         Every claimer runs the same code and every claimer's balance is updated the same way,
///         so an observer cannot tell a winner from a loser.
///
///         ## Dead tickets and rollovers
///
///         Withdrawing shrinks your ranges from the top by exactly the amount you took out. The
///         released tickets become *dead*: still inside `[0, totalTickets)`, owned by nobody. If
///         a draw lands on a dead ticket, no claim ever hits and the prize rolls over into the
///         next round (`requestSweep` → `finalizeSweep`) — a rollover jackpot. Dead tickets are
///         the price of keeping stake sizes private. The rollover rate is publicly auditable from
///         the `Swept` events: `rolledOver == prize` means that round found no owner.
///
///         ## The honest boundary
///
///         Pooled money has to touch a public yield venue, so the *aggregate* is public by
///         necessity: `deployedPrincipal`, `prizeReserve` and each round's `totalTickets` and
///         `prize` are plaintext. What stays confidential is every per-user quantity. Two
///         residual leaks are worth naming:
///
///           1. `finalizeEntries` reveals the cursor total, i.e. the sum of all deposits so far.
///              Deposits made between two closes are hidden inside that batch, so batch size is
///              the anonymity set.
///           2. `finalizeSweep` reveals *whether* a round's prize was claimed, never by whom.
///              The anonymity set is everyone who called `claim` for that round — and calling
///              `claim` is cheap and rational for every depositor, winner or not.
contract MegaPot is ZamaEthereumConfig, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Maximum live ticket ranges per depositor. Bounds the FHE work in `withdraw` and
    ///         `claim`. A deposit that would exceed it compacts the depositor's ranges into one.
    uint256 public constant MAX_RANGES = 4;

    // --------------------------------------------------------------------- //
    //                               Types                                    //
    // --------------------------------------------------------------------- //

    enum RoundState {
        None,
        /// @dev Entries are being taken; the cursor is still moving.
        Open,
        /// @dev Entries closed, waiting for the cursor total to be revealed.
        Closing,
        /// @dev Cursor revealed; the draw may run once `drawTime` passes.
        Drawable,
        /// @dev Drawn; depositors may claim until `claimDeadline`.
        Claimable,
        /// @dev Claim window over, waiting for the unclaimed remainder to be revealed.
        Sweeping,
        /// @dev Fully settled; any unclaimed prize has rolled into `prizeReserve`.
        Settled
    }

    struct Round {
        uint64 drawTime; // earliest timestamp the draw may run
        uint64 claimDeadline; // set at draw time; after it, the round may be swept
        uint64 totalTickets; // revealed cursor snapshot — the draw's modulus
        uint64 prize; // cUSDC awarded by this round
        RoundState state;
        euint64 cursorSnapshot; // encrypted cursor at close (revealed by finalizeEntries)
        euint64 ticket; // encrypted winning ticket
        euint64 unclaimed; // encrypted remainder of `prize` still unawarded
    }

    /// @notice A half-open, encrypted ticket range `[lower, upper)` owned by one depositor.
    struct Range {
        euint64 lower;
        euint64 upper;
        uint64 round; // first round this range is eligible for
    }

    // --------------------------------------------------------------------- //
    //                            Immutables                                  //
    // --------------------------------------------------------------------- //

    /// @notice The confidential deposit token (ERC-7984 wrapper around `asset`).
    IConfidentialWrapper public immutable cToken;
    /// @notice The public underlying token the yield source understands (e.g. USDC).
    IERC20 public immutable asset;

    // --------------------------------------------------------------------- //
    //                          Wiring / roles                                //
    // --------------------------------------------------------------------- //

    IYieldSource public yieldSource;
    address public keeper;

    // --------------------------------------------------------------------- //
    //                       Confidential state                               //
    // --------------------------------------------------------------------- //

    /// @dev Encrypted pool balance per depositor (principal + winnings).
    mapping(address => euint64) private _balance;
    /// @dev Encrypted ticket ranges per depositor.
    mapping(address => Range[]) private _ranges;
    /// @dev Encrypted running ticket cursor. Only its running total is ever revealed.
    euint64 private _cursor;
    /// @dev Encrypted cUSDC received but not yet unwrapped into the yield source.
    euint64 private _pendingDeploy;
    /// @dev Last amount actually paid out to a depositor, so they can check a partial fill.
    mapping(address => euint64) private _lastWithdrawn;

    // --------------------------------------------------------------------- //
    //                          Public state                                  //
    // --------------------------------------------------------------------- //

    Round[] private _rounds;
    /// @notice Round tag stamped on new entries. Ranges are eligible for round `r` iff `round <= r`.
    uint64 public entryRound;
    /// @notice Underlying units currently deployed to the yield source.
    uint256 public deployedPrincipal;
    /// @notice Harvested yield held by the pool as cUSDC, earmarked as the next prize.
    uint64 public prizeReserve;
    /// @notice Harvested yield held as raw underlying, earmarked for Megapot ticket purchases on
    ///         Base. Never mixes with principal and never returns to it.
    uint256 public ticketBudget;
    /// @notice Revealed ticket total as of the last `finalizeEntries`.
    uint64 public settledTickets;
    /// @notice Whether a depositor has already claimed a round.
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    /// @dev One-based `entryRound` at which a depositor last compacted their ranges. Compacting
    ///      releases the old ranges as dead tickets, so it is rate-limited to once per round —
    ///      otherwise anyone could re-stake in a loop and inflate the ticket space until almost
    ///      every draw rolled over.
    mapping(address => uint64) private _lastCompactRound;

    bool public depositsPaused;

    // --------------------------------------------------------------------- //
    //                         Megapot (Base) wiring                          //
    // --------------------------------------------------------------------- //
    //
    // The lottery the prize is played on lives on Base; this pool lives where FHE works. These
    // three fields are the whole seam. `megapotSpendBps` defaults to zero: routing yield through
    // an external lottery is a deliberate financial choice with a real house edge, so it is opt-in
    // rather than something a deployer gets by accident.

    /// @notice CCTP TokenMessengerV2 on this chain, or zero if the Megapot leg is not wired.
    ITokenMessengerV2 public bridge;
    /// @notice CCTP domain of the chain Megapot runs on (6 = Base).
    uint32 public megapotDomain;
    /// @notice `MegapotTicketAgent` on that chain, left-padded to bytes32.
    bytes32 public ticketAgent;
    /// @notice Share of each harvest routed to Megapot tickets instead of straight to the prize.
    uint16 public megapotSpendBps;

    // --------------------------------------------------------------------- //
    //                              Events                                    //
    // --------------------------------------------------------------------- //

    event KeeperSet(address indexed keeper);
    event YieldSourceSet(address indexed yieldSource);
    event Deposited(address indexed user, uint256 rangeIndex);
    event Restaked(address indexed user);
    event Withdrawn(address indexed user);
    event RoundStarted(uint256 indexed roundId, uint64 drawTime);
    event EntriesClosed(uint256 indexed roundId, euint64 cursorSnapshot);
    event EntriesFinalized(uint256 indexed roundId, uint64 totalTickets);
    event Drawn(uint256 indexed roundId, uint64 prize, uint64 totalTickets);
    event Claimed(uint256 indexed roundId, address indexed user);
    event SweepRequested(uint256 indexed roundId, euint64 unclaimed);
    event Swept(uint256 indexed roundId, uint64 rolledOver);
    event DeployRequested(bytes32 indexed unwrapRequestId);
    event Invested(uint256 amount);
    event Harvested(uint256 surplus, uint64 toPrize, uint256 toTickets);
    event MegapotRouteSet(address bridge, uint32 domain, bytes32 agent);
    event MegapotSpendSet(uint16 bps);
    event BridgedToMegapot(uint256 amount);
    event PrizeFunded(address indexed from, uint256 amount, uint64 minted);
    event TicketBudgetFunded(address indexed from, uint256 amount);
    event BufferRefilled(uint256 amount);
    event ConfigUpdated();

    // --------------------------------------------------------------------- //
    //                              Errors                                    //
    // --------------------------------------------------------------------- //

    error OnlyKeeper();
    error DepositsPaused();
    error YieldSourceNotSet();
    error YieldSourceAlreadySet();
    error PreviousRoundLive();
    error WrongState();
    error TooEarly();
    error NoTickets();
    error NoPrize();
    error AlreadyClaimed();
    error NoYield();
    error NothingToInvest();
    error AmountTooLarge();
    error InsufficientPrincipal();
    error AlreadyCompactedThisRound();
    error MegapotRouteNotSet();
    error BudgetExceeded();
    error InvalidConfig();
    error ZeroAmountFunded();

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert OnlyKeeper();
        _;
    }

    constructor(IConfidentialWrapper cToken_, address governance, address keeper_) Ownable(governance) {
        cToken = cToken_;
        asset = IERC20(cToken_.underlying());
        keeper = keeper_;

        _cursor = FHE.asEuint64(0);
        FHE.allowThis(_cursor);
        _pendingDeploy = FHE.asEuint64(0);
        FHE.allowThis(_pendingDeploy);
    }

    // ===================================================================== //
    //                             Depositing                                //
    // ===================================================================== //

    /// @notice Deposit an **encrypted** amount of cUSDC into the pool and receive an equally
    ///         sized, encrypted ticket range.
    /// @dev    Call `cToken.setOperator(address(pot), until)` first so the pool may move your
    ///         confidential tokens. Build `encAmount` with an encrypted input bound to *this*
    ///         contract and your own address.
    ///
    ///         The transfer is a no-op for the amount you do not actually have: ERC-7984 moves
    ///         `min(amount, yourBalance)` and returns what it moved, so the range that gets
    ///         allocated always matches the tokens that actually arrived.
    function deposit(externalEuint64 encAmount, bytes calldata proof) external nonReentrant {
        if (depositsPaused) revert DepositsPaused();

        euint64 amount = FHE.fromExternal(encAmount, proof);
        FHE.allowTransient(amount, address(cToken));
        euint64 received = cToken.confidentialTransferFrom(msg.sender, address(this), amount);

        _balance[msg.sender] = FHE.add(_balance[msg.sender], received);
        _persistBalance(msg.sender);

        _pendingDeploy = FHE.add(_pendingDeploy, received);
        FHE.allowThis(_pendingDeploy);

        // Keep the range list bounded: fold everything into one range when it is full, so a
        // frequent depositor never makes `claim`/`withdraw` unboundedly expensive. Folding is
        // rate-limited, so a depositor gets a handful of deposits per round before they have to
        // wait for the next one.
        if (_ranges[msg.sender].length >= MAX_RANGES) {
            _compact(msg.sender);
        } else {
            _allocate(msg.sender, received);
        }

        emit Deposited(msg.sender, _ranges[msg.sender].length - 1);
    }

    /// @notice Re-issue your tickets so they cover your **whole** current balance, folding in any
    ///         prizes you have won. Your previous ranges are released (they become dead tickets).
    /// @dev    Once per round — see `_compact`.
    function restake() external nonReentrant {
        _compact(msg.sender);
        emit Restaked(msg.sender);
    }

    /// @notice Withdraw an **encrypted** amount back to your own cUSDC balance.
    /// @dev    Pays out of the pool's cUSDC buffer, so the payout is fully confidential — no
    ///         decryption, no oracle round-trip. If the buffer is short the transfer moves
    ///         nothing and your pool balance is untouched; check `lastWithdrawnOf(you)` (which
    ///         only you can decrypt) to see what actually landed, and retry after the keeper
    ///         calls `refillBuffer`.
    ///
    ///         Withdrawing shrinks your ticket ranges from the top by exactly the amount paid.
    ///         Claim any pending round *before* withdrawing.
    function withdraw(externalEuint64 encAmount, bytes calldata proof) external nonReentrant {
        euint64 want = FHE.fromExternal(encAmount, proof);
        euint64 balance = _balance[msg.sender];

        // Never try to move more than the depositor owns.
        euint64 capped = FHE.min(want, balance);
        FHE.allowTransient(capped, address(cToken));
        euint64 sent = cToken.confidentialTransfer(msg.sender, capped);

        _balance[msg.sender] = FHE.sub(balance, sent);
        _persistBalance(msg.sender);

        _lastWithdrawn[msg.sender] = sent;
        FHE.allowThis(sent);
        FHE.allow(sent, msg.sender);

        _releaseTickets(msg.sender, sent);

        emit Withdrawn(msg.sender);
    }

    // ===================================================================== //
    //                           Round lifecycle                             //
    // ===================================================================== //

    /// @notice Open a new round. Entries accumulate continuously — a depositor from an earlier
    ///         round keeps their tickets and automatically plays this one too.
    function startRound(uint64 drawTime) external onlyKeeper returns (uint256 roundId) {
        uint256 n = _rounds.length;
        if (n > 0) {
            RoundState prev = _rounds[n - 1].state;
            // The previous round must at least be drawn before the next one opens; its sweep may
            // still be in flight.
            if (prev != RoundState.Claimable && prev != RoundState.Sweeping && prev != RoundState.Settled) {
                revert PreviousRoundLive();
            }
        }
        if (n != entryRound) revert WrongState();

        _rounds.push();
        roundId = n;
        Round storage r = _rounds[roundId];
        r.drawTime = drawTime;
        r.state = RoundState.Open;

        emit RoundStarted(roundId, drawTime);
    }

    /// @notice Stop taking entries for `roundId` and publish the encrypted cursor for decryption.
    ///         Deposits made from here on are tagged for the *next* round.
    function closeEntries(uint256 roundId) external onlyKeeper {
        Round storage r = _rounds[roundId];
        if (r.state != RoundState.Open) revert WrongState();

        r.cursorSnapshot = _cursor;
        FHE.makePubliclyDecryptable(r.cursorSnapshot);
        r.state = RoundState.Closing;
        entryRound = uint64(roundId) + 1;

        emit EntriesClosed(roundId, r.cursorSnapshot);
    }

    /// @notice Submit the publicly decrypted cursor total together with the KMS proof. This is
    ///         the one moment the pool's aggregate stake becomes plaintext; individual deposits
    ///         stay hidden inside it.
    /// @dev    Permissionless — the proof is what authorises the value, not the caller.
    function finalizeEntries(uint256 roundId, uint64 totalTickets, bytes calldata decryptionProof) external {
        Round storage r = _rounds[roundId];
        if (r.state != RoundState.Closing) revert WrongState();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(r.cursorSnapshot);
        FHE.checkSignatures(handles, abi.encode(totalTickets), decryptionProof);

        r.totalTickets = totalTickets;
        r.state = RoundState.Drawable;
        settledTickets = totalTickets;

        emit EntriesFinalized(roundId, totalTickets);
    }

    /// @notice Draw the round: pick an encrypted winning ticket and lock in the prize.
    /// @dev    The ticket is `rand() mod totalTickets`. The modulo bias is bounded by
    ///         `totalTickets / 2^64`, i.e. below 1e-13 for any realistic pool.
    function draw(uint256 roundId, uint64 claimWindow) external onlyKeeper {
        Round storage r = _rounds[roundId];
        if (r.state != RoundState.Drawable) revert WrongState();
        if (block.timestamp < r.drawTime) revert TooEarly();
        if (r.totalTickets == 0) revert NoTickets();

        uint64 prize = prizeReserve;
        if (prize == 0) revert NoPrize();
        prizeReserve = 0;

        euint64 ticket = FHE.rem(FHE.randEuint64(), r.totalTickets);
        FHE.allowThis(ticket);
        r.ticket = ticket;

        r.prize = prize;
        r.unclaimed = FHE.asEuint64(prize);
        FHE.allowThis(r.unclaimed);

        r.claimDeadline = uint64(block.timestamp) + claimWindow;
        r.state = RoundState.Claimable;

        emit Drawn(roundId, prize, r.totalTickets);
    }

    /// @notice Claim a round. Costs the same and looks the same whether or not you won — the
    ///         award is `select(hit, prize, 0)` and lands in your encrypted balance.
    /// @dev    Every depositor should call this every round: it is the only way a win is paid,
    ///         and it is what makes the winner indistinguishable from everyone else.
    function claim(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        if (r.state != RoundState.Claimable) revert WrongState();
        if (hasClaimed[roundId][msg.sender]) revert AlreadyClaimed();
        hasClaimed[roundId][msg.sender] = true;

        Range[] storage ranges = _ranges[msg.sender];
        euint64 ticket = r.ticket;
        euint64 award = FHE.asEuint64(0);

        for (uint256 i; i < ranges.length; ++i) {
            Range storage range = ranges[i];
            if (range.round > roundId) continue; // allocated after this round closed

            // hit = lower <= ticket < upper. Ranges are disjoint, so at most one can hit.
            ebool hit = FHE.and(FHE.ge(ticket, range.lower), FHE.lt(ticket, range.upper));
            award = FHE.select(hit, r.unclaimed, award);
        }

        // `unclaimed` is either the full prize or zero, so this both pays the winner and makes a
        // second winning claim impossible.
        r.unclaimed = FHE.sub(r.unclaimed, award);
        FHE.allowThis(r.unclaimed);

        _balance[msg.sender] = FHE.add(_balance[msg.sender], award);
        _persistBalance(msg.sender);

        emit Claimed(roundId, msg.sender);
    }

    /// @notice After the claim window, publish the unclaimed remainder for decryption so it can
    ///         roll over into the next round.
    function requestSweep(uint256 roundId) external {
        Round storage r = _rounds[roundId];
        if (r.state != RoundState.Claimable) revert WrongState();
        if (block.timestamp < r.claimDeadline) revert TooEarly();

        FHE.makePubliclyDecryptable(r.unclaimed);
        r.state = RoundState.Sweeping;

        emit SweepRequested(roundId, r.unclaimed);
    }

    /// @notice Submit the decrypted remainder with its KMS proof; it rolls into `prizeReserve`.
    ///         Reveals only *whether* the round was won, never by whom.
    function finalizeSweep(uint256 roundId, uint64 unclaimedAmount, bytes calldata decryptionProof) external {
        Round storage r = _rounds[roundId];
        if (r.state != RoundState.Sweeping) revert WrongState();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(r.unclaimed);
        FHE.checkSignatures(handles, abi.encode(unclaimedAmount), decryptionProof);

        r.state = RoundState.Settled;
        prizeReserve += unclaimedAmount;

        emit Swept(roundId, unclaimedAmount);
    }

    // ===================================================================== //
    //                        Yield source plumbing                          //
    // ===================================================================== //

    /// @notice Start moving newly deposited cUSDC into the yield source: burn the pending amount
    ///         and let the wrapper release the underlying. Reveals the **batch aggregate** only.
    /// @dev    Finish with `cToken.finalizeUnwrap(id, amount, proof)`, then `invest()`.
    function requestDeploy() external onlyKeeper returns (bytes32 unwrapRequestId) {
        euint64 pending = _pendingDeploy;
        FHE.allowTransient(pending, address(cToken));
        unwrapRequestId = cToken.unwrap(address(this), address(this), pending);

        // The wrapper burns `min(pending, ourBalance)` and hands back that amount's handle, so
        // subtracting it leaves any unburnable remainder pending for the next attempt.
        _pendingDeploy = FHE.sub(pending, euint64.wrap(unwrapRequestId));
        FHE.allowThis(_pendingDeploy);

        emit DeployRequested(unwrapRequestId);
    }

    /// @notice Push idle underlying into the yield source.
    /// @dev    Sweeps everything except `ticketBudget`, which is harvested yield already earmarked
    ///         for Megapot. Letting it be invested would quietly turn yield back into principal.
    function invest() external onlyKeeper returns (uint256 amount) {
        if (address(yieldSource) == address(0)) revert YieldSourceNotSet();
        uint256 held = asset.balanceOf(address(this));
        amount = held > ticketBudget ? held - ticketBudget : 0;
        if (amount == 0) revert NothingToInvest();

        asset.forceApprove(address(yieldSource), amount);
        yieldSource.deposit(amount);
        deployedPrincipal += amount;

        emit Invested(amount);
    }

    /// @notice Realise the yield: pull everything the yield source earned above principal, wrap
    ///         it into cUSDC and earmark it as the next prize. Permissionless — it can only ever
    ///         move surplus, never principal.
    function harvest() external returns (uint256 surplus) {
        if (address(yieldSource) == address(0)) revert YieldSourceNotSet();
        uint256 total = yieldSource.totalAssets();
        if (total <= deployedPrincipal) revert NoYield();
        surplus = total - deployedPrincipal;

        uint256 before = asset.balanceOf(address(this));
        yieldSource.withdraw(surplus, address(this));
        uint256 got = asset.balanceOf(address(this)) - before;

        // Split the realised yield: part is played on Megapot, the rest becomes prize money
        // directly. Both paths end up funding the same confidential draw.
        uint256 toTickets = (got * megapotSpendBps) / 10_000;
        ticketBudget += toTickets;

        uint64 minted = _wrapIntoPool(got - toTickets);
        prizeReserve += minted;

        emit Harvested(got, minted, toTickets);
    }

    // ===================================================================== //
    //                       Megapot (Base) settlement                       //
    // ===================================================================== //

    /// @notice Burn `amount` of the earmarked ticket budget to CCTP, to be minted to the
    ///         `MegapotTicketAgent` on Base, which buys the tickets.
    /// @dev    The destination is fixed by `ticketAgent` at burn time, so the off-chain relayer
    ///         that carries the attestation can delay the transfer but cannot redirect it.
    /// @param  maxFee Cap on CCTP's fee; zero is correct for standard hard-finality transfers.
    function bridgeToMegapot(uint256 amount, uint256 maxFee) external onlyKeeper {
        if (address(bridge) == address(0) || ticketAgent == bytes32(0)) revert MegapotRouteNotSet();
        if (amount == 0 || amount > ticketBudget) revert BudgetExceeded();

        ticketBudget -= amount;

        asset.forceApprove(address(bridge), amount);
        bridge.depositForBurn(amount, megapotDomain, ticketAgent, address(asset), bytes32(0), maxFee, 2000);
        asset.forceApprove(address(bridge), 0);

        emit BridgedToMegapot(amount);
    }

    /// @notice Fund the Megapot ticket budget directly, rather than waiting for `harvest` to fill
    ///         it from yield. Pull-based and permissionless, the same shape as `fundPrize`.
    /// @dev    Useful wherever the pool has no yield venue to skim — notably on testnet, where the
    ///         Megapot leg still needs funding to be exercised end to end.
    function fundTicketBudget(uint256 amount) external {
        if (amount == 0) revert ZeroAmountFunded();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        ticketBudget += amount;

        emit TicketBudgetFunded(msg.sender, amount);
    }

    /// @notice Fold externally supplied underlying into the prize reserve. This is how Megapot
    ///         winnings re-enter the pool after their trip back from Base.
    /// @dev    Permissionless, and deliberately *pull*-based: it takes `amount` from the caller
    ///         rather than sweeping the pool's own balance. That is what keeps arriving winnings
    ///         from ever being confused with freshly unwrapped deposits waiting to be invested —
    ///         principal and prize money can never cross over by accident. See `PrizeInbox`.
    function fundPrize(uint256 amount) external returns (uint64 minted) {
        if (amount == 0) revert ZeroAmountFunded();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        minted = _wrapIntoPool(amount);
        prizeReserve += minted;

        emit PrizeFunded(msg.sender, amount, minted);
    }

    /// @notice Top the withdrawal buffer back up: pull `amount` of principal out of the yield
    ///         source and wrap it into pool-held cUSDC.
    /// @dev    The amount is a keeper-chosen aggregate, unlinked to any individual withdrawal.
    function refillBuffer(uint256 amount) external onlyKeeper {
        if (address(yieldSource) == address(0)) revert YieldSourceNotSet();
        if (amount > deployedPrincipal) revert InsufficientPrincipal();

        uint256 before = asset.balanceOf(address(this));
        yieldSource.withdraw(amount, address(this));
        uint256 got = asset.balanceOf(address(this)) - before;

        // Credit only what the venue actually returned. Decrementing by the *requested* amount
        // after a partial fill would leave principal behind that `harvest` then mistakes for
        // yield — and pays out as a prize.
        deployedPrincipal -= got;
        _wrapIntoPool(got);

        emit BufferRefilled(got);
    }

    // ===================================================================== //
    //                          Admin / safety                               //
    // ===================================================================== //

    function setYieldSource(address source) external onlyOwner {
        if (address(yieldSource) != address(0)) revert YieldSourceAlreadySet();
        yieldSource = IYieldSource(source);
        emit YieldSourceSet(source);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice Wire the Megapot leg: the CCTP messenger here, the domain Megapot runs on, and the
    ///         agent contract that will hold the lottery position there.
    function setMegapotRoute(address bridge_, uint32 domain, address agent) external onlyOwner {
        bridge = ITokenMessengerV2(bridge_);
        megapotDomain = domain;
        ticketAgent = bytes32(uint256(uint160(agent)));
        emit MegapotRouteSet(bridge_, domain, ticketAgent);
    }

    /// @notice Set the share of each harvest played on Megapot rather than paid straight out.
    /// @dev    Deliberately opt-in and adjustable. Megapot takes `feeBps` of every ticket (3,000
    ///         on Base mainnet at the time of writing), so this trades expected value for
    ///         variance — steady yield becomes a chance at a much larger prize. Governance's call,
    ///         not a default.
    function setMegapotSpendBps(uint16 bps) external onlyOwner {
        if (bps > 10_000) revert InvalidConfig();
        megapotSpendBps = bps;
        emit MegapotSpendSet(bps);
    }

    function setDepositsPaused(bool paused) external onlyKeeper {
        depositsPaused = paused;
        emit ConfigUpdated();
    }

    /// @notice Emergency: pull all principal out of the yield source into the pool's buffer,
    ///         where it fully backs confidential withdrawals.
    function emergencyUnwind() external onlyOwner {
        if (address(yieldSource) == address(0)) revert YieldSourceNotSet();
        depositsPaused = true;

        uint256 amount = deployedPrincipal;
        uint256 before = asset.balanceOf(address(this));
        yieldSource.withdraw(amount, address(this));
        uint256 got = asset.balanceOf(address(this)) - before;

        // Same reasoning as `refillBuffer`: if the venue is illiquid and only part comes back,
        // the remainder is still principal and must keep counting as such. Call again once the
        // venue frees up.
        deployedPrincipal -= got;
        _wrapIntoPool(got);

        emit BufferRefilled(got);
    }

    // ===================================================================== //
    //                               Views                                   //
    // ===================================================================== //

    /// @notice Your encrypted pool balance. Only you (and this contract) can decrypt it.
    function confidentialBalanceOf(address user) external view returns (euint64) {
        return _balance[user];
    }

    /// @notice The amount your last `withdraw` actually paid out. Only you can decrypt it.
    function lastWithdrawnOf(address user) external view returns (euint64) {
        return _lastWithdrawn[user];
    }

    /// @notice Your encrypted ticket ranges — your odds, readable only by you.
    function rangesOf(address user) external view returns (Range[] memory) {
        return _ranges[user];
    }

    function rangeCountOf(address user) external view returns (uint256) {
        return _ranges[user].length;
    }

    /// @notice Whether `user` may still fold their ranges (via `restake`, or implicitly on a
    ///         deposit that fills the list) during the current entry round.
    function canCompact(address user) external view returns (bool) {
        return _lastCompactRound[user] != entryRound + 1;
    }

    /// @notice The encrypted ticket cursor. Its total is revealed once per round at close.
    function cursor() external view returns (euint64) {
        return _cursor;
    }

    /// @notice Encrypted cUSDC awaiting deployment into the yield source.
    function pendingDeploy() external view returns (euint64) {
        return _pendingDeploy;
    }

    function roundsLength() external view returns (uint256) {
        return _rounds.length;
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    // ===================================================================== //
    //                             Internal                                  //
    // ===================================================================== //

    /// @dev Allocate `amount` tickets at the top of the cursor to `user`.
    function _allocate(address user, euint64 amount) private {
        euint64 lower = _cursor;
        euint64 upper = FHE.add(lower, amount);

        _cursor = upper;
        FHE.allowThis(lower);
        FHE.allowThis(upper);
        FHE.allow(lower, user);
        FHE.allow(upper, user);

        _ranges[user].push(Range({lower: lower, upper: upper, round: entryRound}));
    }

    /// @dev Release every range the user holds and issue a single fresh one covering their whole
    ///      balance. The released tickets become dead, which is why this is capped at once per
    ///      round: repeated compaction is the one cheap way to inflate the ticket space, and an
    ///      inflated space means most draws land on dead tickets and roll over.
    function _compact(address user) private {
        uint64 stamp = entryRound + 1;
        if (_lastCompactRound[user] == stamp) revert AlreadyCompactedThisRound();
        _lastCompactRound[user] = stamp;

        delete _ranges[user];
        _allocate(user, _balance[user]);
    }

    /// @dev Shrink the user's ranges from the top by `amount`, releasing exactly that many
    ///      tickets. Runs over every range because the cut point is encrypted; `MAX_RANGES`
    ///      keeps that bounded.
    function _releaseTickets(address user, euint64 amount) private {
        Range[] storage ranges = _ranges[user];
        euint64 remaining = amount;

        for (uint256 i = ranges.length; i > 0; --i) {
            Range storage range = ranges[i - 1];
            euint64 span = FHE.sub(range.upper, range.lower);
            euint64 cut = FHE.min(span, remaining);

            euint64 newUpper = FHE.sub(range.upper, cut);
            remaining = FHE.sub(remaining, cut);

            range.upper = newUpper;
            FHE.allowThis(newUpper);
            FHE.allow(newUpper, user);
        }
    }

    /// @dev Wrap `amount` of underlying held by this contract into pool-held cUSDC.
    function _wrapIntoPool(uint256 amount) private returns (uint64 minted) {
        if (amount == 0) return 0;
        uint256 rate = cToken.rate();
        uint256 units = amount / rate;
        if (units > type(uint64).max) revert AmountTooLarge();

        asset.forceApprove(address(cToken), units * rate);
        cToken.wrap(address(this), units * rate);
        minted = uint64(units);
    }

    function _persistBalance(address user) private {
        FHE.allowThis(_balance[user]);
        FHE.allow(_balance[user], user);
    }
}
