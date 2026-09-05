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

    /// @notice The prize every depositor plays, funded by the pool's yield.
    uint8 public constant MAIN = 0;
    /// @notice The opt-in prize, funded by winnings returning from Megapot on Base.
    uint8 public constant MEGA = 1;

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

    /// @notice One independent prize game: its own ticket space, rounds and reserve.
    ///
    /// @dev    Two tracks run over a single balance ledger. `MAIN` includes every depositor and is
    ///         funded by yield; `MEGA` includes only those who opted in and is funded by winnings
    ///         coming back from Megapot on Base. Being in `MEGA` is purely additive — it never
    ///         removes you from `MAIN`, so opting in cannot cost you anything but gas.
    ///
    ///         Both tracks run the *same* selection code, just indexed. That is deliberate: the
    ///         confidential draw is the part worth getting right once.
    struct Track {
        euint64 cursor; // encrypted running ticket cursor
        uint64 entryRound; // round tag stamped on new entries
        uint64 settledTickets; // revealed ticket total as of the last finalizeEntries
        uint64 settledAt; // when that reveal happened — see `_megapotEligible`
        uint64 prizeReserve; // cUSDC held as this track's next prize
        Round[] rounds;
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

    /// @dev Encrypted pool balance per depositor (principal + winnings). Shared by both tracks —
    ///      there is exactly one ledger, and the tracks are two ways of playing it.
    mapping(address => euint64) private _balance;
    /// @dev Encrypted ticket ranges per depositor, per track.
    mapping(uint8 => mapping(address => Range[])) private _ranges;
    /// @dev Encrypted cUSDC received but not yet unwrapped into the yield source.
    euint64 private _pendingDeploy;
    /// @dev Last amount actually paid out to a depositor, so they can check a partial fill.
    mapping(address => euint64) private _lastWithdrawn;
    /// @dev What a depositor was awarded by a round. Readable only by them, and present for
    ///      everyone who claimed — losers hold a handle that decrypts to zero, which is what keeps
    ///      the mere existence of an award from identifying the winner.
    mapping(uint8 => mapping(uint256 => mapping(address => euint64))) private _award;

    // --------------------------------------------------------------------- //
    //                          Public state                                  //
    // --------------------------------------------------------------------- //

    /// @dev Index with `MAIN` / `MEGA`.
    Track[2] private _tracks;
    /// @notice Underlying units currently deployed to the yield source.
    uint256 public deployedPrincipal;
    /// @notice Harvested yield held as raw underlying, earmarked for Megapot ticket purchases on
    ///         Base. Never mixes with principal and never returns to it.
    uint256 public ticketBudget;
    /// @notice Whether a depositor has already claimed a round of a track.
    mapping(uint8 => mapping(uint256 => mapping(address => bool))) public hasClaimed;
    /// @dev One-based `entryRound` at which a depositor last reshaped their ranges on a track.
    ///      Reshaping releases the old ranges as dead tickets, so it is rate-limited to once per
    ///      round — otherwise anyone could re-stake in a loop and inflate the ticket space until
    ///      almost every draw rolled over. Opting in and out of `MEGA` shares this limit for the
    ///      same reason.
    mapping(uint8 => mapping(address => uint64)) private _lastCompactRound;

    /// @notice Whether a depositor plays the Megapot-funded track as well as the main one.
    ///
    /// @dev    Public on purpose. It leaks a *preference*, never an amount: an observer learns
    ///         that you are playing the second game, not how much you have in either. Making it
    ///         encrypted would mean the ticket ratio in `harvest` could not be computed in the
    ///         clear, and that ratio is the only thing keeping the split fair.
    mapping(address => bool) public playsMegapot;

    /// @notice Underlying the pool aims to keep un-deployed so withdrawals always settle at once.
    ///         `topUpBuffer` is permissionless, so a shortfall is repairable by anyone.
    uint256 public bufferTarget;

    /// @notice How far apart the two tracks' ticket reveals may be before `harvest` stops trusting
    ///         their ratio and routes nothing to Megapot.
    ///
    /// @dev    `settledTickets` is written per track, independently, by `finalizeEntries`. A MAIN
    ///         reveal from January against a MEGA reveal from June is not a ratio, it is noise.
    ///         Rather than divide two unrelated snapshots, refuse the split and say so.
    uint64 public splitMaxSkew = 7 days;

    bool public depositsPaused;

    // --------------------------------------------------------------------- //
    //                         Megapot (Base) wiring                          //
    // --------------------------------------------------------------------- //
    //
    // The lottery the prize is played on lives on Base; this pool lives where FHE works. These
    // three fields are the whole seam.
    //
    // There is deliberately no governance-level "spend N% of yield on Megapot" knob. Each
    // depositor sets their own allocation, and the harvest ratio is already the stake-weighted
    // average of those choices — a second global multiplier would mean the same thing twice, and
    // would let governance quietly override a choice that is the depositor's to make.

    /// @notice CCTP TokenMessengerV2 on this chain, or zero if the Megapot leg is not wired.
    ITokenMessengerV2 public bridge;
    /// @notice CCTP domain of the chain Megapot runs on (6 = Base).
    uint32 public megapotDomain;
    /// @notice `MegapotTicketAgent` on that chain, left-padded to bytes32.
    bytes32 public ticketAgent;

    // --------------------------------------------------------------------- //
    //                              Events                                    //
    // --------------------------------------------------------------------- //

    event KeeperSet(address indexed keeper);
    event YieldSourceSet(address indexed yieldSource);
    event Deposited(address indexed user, uint256 rangeIndex);
    event Restaked(address indexed user);
    event Withdrawn(address indexed user);
    event RoundStarted(uint8 indexed track, uint256 indexed roundId, uint64 drawTime);
    event EntriesClosed(uint8 indexed track, uint256 indexed roundId, euint64 cursorSnapshot);
    event EntriesFinalized(uint8 indexed track, uint256 indexed roundId, uint64 totalTickets);
    event Drawn(uint8 indexed track, uint256 indexed roundId, uint64 prize, uint64 totalTickets);
    event Claimed(uint8 indexed track, uint256 indexed roundId, address indexed user);
    event SweepRequested(uint8 indexed track, uint256 indexed roundId, euint64 unclaimed);
    event Swept(uint8 indexed track, uint256 indexed roundId, uint64 rolledOver);
    event MegapotOptIn(address indexed user);
    event MegapotOptOut(address indexed user);
    event BufferTargetSet(uint256 target);
    event DeployRequested(bytes32 indexed unwrapRequestId);
    event Invested(uint256 amount);
    event Harvested(uint256 surplus, uint64 toPrize, uint256 toTickets);
    event MegapotRouteSet(address bridge, uint32 domain, bytes32 agent);
    event MegapotAllocationSet(address indexed user, uint16 bps);
    event BridgedToMegapot(uint256 amount);
    event PrizeFunded(uint8 indexed track, address indexed from, uint256 amount, uint64 minted);
    event TicketBudgetFunded(address indexed from, uint256 amount);
    event BufferRefilled(uint256 amount);
    event ConfigUpdated();

    /// @notice `harvest` declined to route anything to Megapot. `reason` is 0 when a track has
    ///         never settled, 1 when the two reveals are further apart than `splitMaxSkew`.
    /// @dev    Emitted rather than reverted on purpose — see `_megapotEligible`.
    event SplitSkipped(uint8 reason);

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
    error UnknownTrack();
    error AlreadyOptedIn();
    error NotOptedIn();
    error BufferFull();
    error UnsupportedToken();
    error AssetMismatch();

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert OnlyKeeper();
        _;
    }

    modifier validTrack(uint8 track) {
        if (track > MEGA) revert UnknownTrack();
        _;
    }

    constructor(IConfidentialWrapper cToken_, address governance, address keeper_) Ownable(governance) {
        if (address(cToken_) == address(0)) revert UnsupportedToken();
        address underlying = cToken_.underlying();
        if (underlying == address(0)) revert UnsupportedToken();

        // The pool keeps two sets of books. Its *public* accounting — deployedPrincipal,
        // bufferTarget, ticketBudget, every amount the yield source sees — is denominated in
        // underlying units. Its *confidential* ledger — balances, the ticket space, prizeReserve —
        // is denominated in wrapper units. Those two scales coincide only when the wrapper's rate
        // is 1, which is to say when the underlying has six decimals or fewer.
        //
        // Anything else silently mixes units by a factor of 10^(d-6) and leaves truncation dust in
        // every wrap. Refuse it at construction rather than discover it in production.
        if (cToken_.rate() != 1) revert UnsupportedToken();

        cToken = cToken_;
        asset = IERC20(underlying);
        keeper = keeper_;

        _tracks[MAIN].cursor = FHE.asEuint64(0);
        FHE.allowThis(_tracks[MAIN].cursor);
        _tracks[MEGA].cursor = FHE.asEuint64(0);
        FHE.allowThis(_tracks[MEGA].cursor);
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

        // Folding a full range list deletes the ranges, so settle any pending win first —
        // guarded on the list actually being full, so an ordinary deposit pays nothing for a
        // claim it does not need.
        if (
            _ranges[MAIN][msg.sender].length >= MAX_RANGES ||
            (playsMegapot[msg.sender] && _ranges[MEGA][msg.sender].length >= MAX_RANGES)
        ) {
            _settleClaims(msg.sender);
        }

        // Keep the range list bounded: fold everything into one range when it is full, so a
        // frequent depositor never makes `claim`/`withdraw` unboundedly expensive. Folding is
        // rate-limited, so a depositor gets a handful of deposits per round before they have to
        // wait for the next one.
        _grow(MAIN, msg.sender, received);
        // The Megapot track mirrors the main one for anyone who opted in, so one deposit buys
        // tickets in both games at once.
        if (playsMegapot[msg.sender]) _grow(MEGA, msg.sender, received);

        emit Deposited(msg.sender, _ranges[MAIN][msg.sender].length - 1);
    }

    /// @notice Re-issue your tickets so they cover your **whole** current balance, folding in any
    ///         prizes you have won. Your previous ranges are released (they become dead tickets).
    /// @dev    Once per round — see `_compact`.
    function restake() external nonReentrant {
        // Settle first — `_compact` deletes every range, so an unclaimed win would go with them.
        _settleClaims(msg.sender);

        _compact(MAIN, msg.sender);
        if (playsMegapot[msg.sender]) _compact(MEGA, msg.sender);
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
    ///         Any round you have won but not claimed is settled first, so the prize is already
    ///         in your balance before the cap applies — withdrawing everything takes the winnings
    ///         with it.
    function withdraw(externalEuint64 encAmount, bytes calldata proof) external nonReentrant {
        // Settle first, so a pending win is in the balance this withdrawal caps against — and so
        // shrinking the ranges below cannot destroy the range that won it.
        _settleClaims(msg.sender);

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

        _releaseTickets(MAIN, msg.sender, sent);
        if (playsMegapot[msg.sender]) _releaseTickets(MEGA, msg.sender, sent);

        emit Withdrawn(msg.sender);
    }

    // ===================================================================== //
    //                         Megapot opt-in                                //
    // ===================================================================== //

    /// @notice Also play the Megapot-funded prize, on top of the main one.
    ///
    /// @dev    Opting in mints you a ticket range on the `MEGA` cursor covering your *current*
    ///         balance. It is purely additive: your main-track tickets are untouched, so opting in
    ///         cannot reduce your odds on the main prize or put your principal at risk. What it
    ///         does cost is that your share of harvested yield is routed to buying Megapot tickets
    ///         instead of straight into the main prize — see `harvest`.
    ///
    ///         Deposits made after this point mirror onto both tracks automatically. Winnings
    ///         credited by a claim do not, on either track; fold them in with `restake`.
    function optIn() external nonReentrant {
        if (playsMegapot[msg.sender]) revert AlreadyOptedIn();
        playsMegapot[msg.sender] = true;

        _compact(MEGA, msg.sender);

        emit MegapotOptIn(msg.sender);
    }

    /// @notice Stop playing the Megapot prize. Your main-track position is untouched.
    ///
    /// @dev    Your `MEGA` ranges are dropped, which leaves dead tickets in that space exactly as
    ///         a withdrawal would — so a `MEGA` draw may roll over. Leaving is always allowed; it
    ///         is re-joining that costs a reshape, and `optIn` is where the rate limit sits.
    function optOut() external nonReentrant {
        if (!playsMegapot[msg.sender]) revert NotOptedIn();
        playsMegapot[msg.sender] = false;

        // Dropping the ranges is all that is needed: the cursor never rewinds, so the positions
        // they covered simply become dead. Shrinking them first would burn FHE gas to reach the
        // same state.
        //
        // Deliberately *not* rate-limited. Inflating the ticket space requires minting, and only
        // `optIn` mints — capping that is what closes the loop. Charging opt-out for the privilege
        // of leaving would just trap people in a game they no longer want to play.
        delete _ranges[MEGA][msg.sender];

        emit MegapotOptOut(msg.sender);
    }

    // ===================================================================== //
    //                           Round lifecycle                             //
    // ===================================================================== //

    /// @notice Open a new round. Entries accumulate continuously — a depositor from an earlier
    ///         round keeps their tickets and automatically plays this one too.
    function startRound(uint8 track, uint64 drawTime)
        external
        onlyKeeper
        validTrack(track)
        returns (uint256 roundId)
    {
        Track storage t = _tracks[track];
        uint256 n = t.rounds.length;
        if (n > 0) {
            RoundState prev = t.rounds[n - 1].state;
            // The previous round must at least be drawn before the next one opens; its sweep may
            // still be in flight.
            if (prev != RoundState.Claimable && prev != RoundState.Sweeping && prev != RoundState.Settled) {
                revert PreviousRoundLive();
            }
        }
        if (n != t.entryRound) revert WrongState();

        t.rounds.push();
        roundId = n;
        Round storage r = t.rounds[roundId];
        r.drawTime = drawTime;
        r.state = RoundState.Open;

        emit RoundStarted(track, roundId, drawTime);
    }

    /// @notice Stop taking entries for `roundId` and publish the encrypted cursor for decryption.
    ///         Deposits made from here on are tagged for the *next* round.
    function closeEntries(uint8 track, uint256 roundId) external onlyKeeper validTrack(track) {
        Track storage t = _tracks[track];
        Round storage r = t.rounds[roundId];
        if (r.state != RoundState.Open) revert WrongState();

        r.cursorSnapshot = t.cursor;
        FHE.makePubliclyDecryptable(r.cursorSnapshot);
        r.state = RoundState.Closing;
        t.entryRound = uint64(roundId) + 1;

        emit EntriesClosed(track, roundId, r.cursorSnapshot);
    }

    /// @notice Submit the publicly decrypted cursor total together with the KMS proof. This is
    ///         the one moment the pool's aggregate stake becomes plaintext; individual deposits
    ///         stay hidden inside it.
    /// @dev    Permissionless — the proof is what authorises the value, not the caller.
    function finalizeEntries(uint8 track, uint256 roundId, uint64 totalTickets, bytes calldata decryptionProof)
        external
        validTrack(track)
    {
        Track storage t = _tracks[track];
        Round storage r = t.rounds[roundId];
        if (r.state != RoundState.Closing) revert WrongState();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(r.cursorSnapshot);
        FHE.checkSignatures(handles, abi.encode(totalTickets), decryptionProof);

        r.totalTickets = totalTickets;
        r.state = RoundState.Drawable;
        t.settledTickets = totalTickets;
        t.settledAt = uint64(block.timestamp);

        emit EntriesFinalized(track, roundId, totalTickets);
    }

    /// @notice Draw the round: pick an encrypted winning ticket and lock in the prize.
    /// @dev    The ticket is `rand() mod totalTickets`. The modulo bias is bounded by
    ///         `totalTickets / 2^64`, i.e. below 1e-13 for any realistic pool.
    function draw(uint8 track, uint256 roundId, uint64 claimWindow) external onlyKeeper validTrack(track) {
        Track storage t = _tracks[track];
        Round storage r = t.rounds[roundId];
        if (r.state != RoundState.Drawable) revert WrongState();
        if (block.timestamp < r.drawTime) revert TooEarly();
        if (r.totalTickets == 0) revert NoTickets();

        uint64 prize = t.prizeReserve;
        if (prize == 0) revert NoPrize();
        t.prizeReserve = 0;

        euint64 ticket = FHE.rem(FHE.randEuint64(), r.totalTickets);
        FHE.allowThis(ticket);
        r.ticket = ticket;

        r.prize = prize;
        r.unclaimed = FHE.asEuint64(prize);
        FHE.allowThis(r.unclaimed);

        r.claimDeadline = uint64(block.timestamp) + claimWindow;
        r.state = RoundState.Claimable;

        emit Drawn(track, roundId, prize, r.totalTickets);
    }

    /// @notice Claim a round. Costs the same and looks the same whether or not you won — the
    ///         award is `select(hit, prize, 0)` and lands in your encrypted balance.
    /// @dev    Every depositor should call this every round: it is the only way a win is paid,
    ///         and it is what makes the winner indistinguishable from everyone else.
    function claim(uint8 track, uint256 roundId) external nonReentrant validTrack(track) {
        Round storage r = _tracks[track].rounds[roundId];
        if (r.state != RoundState.Claimable) revert WrongState();
        if (hasClaimed[track][roundId][msg.sender]) revert AlreadyClaimed();
        _claim(track, roundId, msg.sender);
    }

    /// @dev The body of a claim, with the state and double-claim checks left to the caller.
    ///
    ///      Split out so reshaping paths can settle a pending win before they touch the ranges
    ///      that win depends on — see `_settleClaims`. Makes no external calls, so lifting it out
    ///      of the `nonReentrant` wrapper adds no reentrancy surface.
    function _claim(uint8 track, uint256 roundId, address user) private {
        Round storage r = _tracks[track].rounds[roundId];
        hasClaimed[track][roundId][user] = true;

        Range[] storage ranges = _ranges[track][user];
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

        _balance[user] = FHE.add(_balance[user], award);
        _persistBalance(user);

        // Keep the award as a handle only this claimer can read, so "what did I win?" is a direct
        // user-decryption rather than a balance diff. Everyone who claims gets one; a loser's
        // decrypts to zero, so holding an award handle reveals nothing about having won.
        _award[track][roundId][user] = award;
        FHE.allowThis(award);
        FHE.allow(award, user);

        emit Claimed(track, roundId, user);
    }

    /// @notice After the claim window, publish the unclaimed remainder for decryption so it can
    ///         roll over into the next round.
    function requestSweep(uint8 track, uint256 roundId) external validTrack(track) {
        Round storage r = _tracks[track].rounds[roundId];
        if (r.state != RoundState.Claimable) revert WrongState();
        if (block.timestamp < r.claimDeadline) revert TooEarly();

        FHE.makePubliclyDecryptable(r.unclaimed);
        r.state = RoundState.Sweeping;

        emit SweepRequested(track, roundId, r.unclaimed);
    }

    /// @notice Submit the decrypted remainder with its KMS proof; it rolls into `prizeReserve`.
    ///         Reveals only *whether* the round was won, never by whom.
    function finalizeSweep(uint8 track, uint256 roundId, uint64 unclaimedAmount, bytes calldata decryptionProof)
        external
        validTrack(track)
    {
        Round storage r = _tracks[track].rounds[roundId];
        if (r.state != RoundState.Sweeping) revert WrongState();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(r.unclaimed);
        FHE.checkSignatures(handles, abi.encode(unclaimedAmount), decryptionProof);

        r.state = RoundState.Settled;
        _tracks[track].prizeReserve += unclaimedAmount;

        emit Swept(track, roundId, unclaimedAmount);
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

        // Split the realised yield. Only the opted-in share is eligible to be played on Megapot,
        // and the split uses the two tracks' revealed ticket totals — public aggregates that leak
        // nothing about any individual. This is what makes the slider honest in both directions:
        // a depositor at 0% never funds a prize they cannot win, and one at 100% is not riding on
        // anybody else's yield.
        uint256 toTickets = _megapotEligible(got);
        ticketBudget += toTickets;

        // Everything the Megapot leg did not take funds the main prize — including the rest of an
        // opted-in depositor's yield, since they are still playing the main draw too.
        uint64 minted = _wrapIntoPool(got - toTickets);
        _tracks[MAIN].prizeReserve += minted;

        emit Harvested(got, minted, toTickets);
    }

    /// @dev How much of a realised harvest is eligible to be played on Megapot.
    ///
    ///      The ratio of the two tracks' revealed ticket totals *is* the stake-weighted average
    ///      allocation, because every MEGA mint is its depositor's MAIN mint scaled by their
    ///      chosen share. So this needs no separate accounting — but it does need three guards,
    ///      and every one of them fails **closed to zero rather than reverting**:
    ///
    ///      `harvest` is permissionless and is the only path from yield to prize. If a Megapot
    ///      misconfiguration could make it revert, a misconfigured second game would take the
    ///      pool's core function down with it. Routing nothing costs opted-in depositors some
    ///      variance; reverting costs everybody their prize.
    ///
    ///      The clamp on the last line is load-bearing, not defensive dressing. MEGA mints are
    ///      not always paired with MAIN mints — raising an allocation mints on MEGA alone — so
    ///      `megaTickets > mainTickets` is reachable, and without the clamp `got - toTickets`
    ///      below would underflow and revert for good.
    function _megapotEligible(uint256 got) private returns (uint256) {
        // Nothing to play it on. Earmarking a ticket budget the pool cannot spend would strand
        // yield that should have become a prize.
        if (address(bridge) == address(0) || ticketAgent == bytes32(0)) {
            emit SplitSkipped(2);
            return 0;
        }

        Track storage main = _tracks[MAIN];
        Track storage mega = _tracks[MEGA];

        if (main.settledTickets == 0 || main.settledAt == 0 || mega.settledAt == 0) {
            emit SplitSkipped(0);
            return 0;
        }

        uint64 skew = main.settledAt > mega.settledAt
            ? main.settledAt - mega.settledAt
            : mega.settledAt - main.settledAt;
        if (skew > splitMaxSkew) {
            emit SplitSkipped(1);
            return 0;
        }

        uint256 megaTickets = mega.settledTickets;
        if (megaTickets > main.settledTickets) megaTickets = main.settledTickets;

        return (got * megaTickets) / main.settledTickets;
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

        // Credit what arrived, not what was asked for — the same partial-fill discipline every
        // other value-in path here follows. A fee-on-transfer asset would otherwise over-credit.
        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = asset.balanceOf(address(this)) - before;
        ticketBudget += got;

        emit TicketBudgetFunded(msg.sender, got);
    }

    /// @notice Fold externally supplied underlying into the prize reserve. This is how Megapot
    ///         winnings re-enter the pool after their trip back from Base.
    /// @dev    Permissionless, and deliberately *pull*-based: it takes `amount` from the caller
    ///         rather than sweeping the pool's own balance. That is what keeps arriving winnings
    ///         from ever being confused with freshly unwrapped deposits waiting to be invested —
    ///         principal and prize money can never cross over by accident. See `PrizeInbox`.
    function fundPrize(uint8 track, uint256 amount) external validTrack(track) returns (uint64 minted) {
        if (amount == 0) revert ZeroAmountFunded();

        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = asset.balanceOf(address(this)) - before;

        minted = _wrapIntoPool(got);
        _tracks[track].prizeReserve += minted;

        emit PrizeFunded(track, msg.sender, got, minted);
    }

    /// @notice Refill the withdrawal buffer to `bufferTarget`. **Permissionless** — this is what
    ///         makes "withdraw at any time" hold without waiting on a keeper.
    ///
    /// @dev    A withdrawal pays from the pool's cUSDC buffer, and its amount is encrypted, so the
    ///         contract cannot size a refill against any particular withdrawal. What it *can* do
    ///         is keep a public target topped up, and let anyone repair a shortfall in the same
    ///         block they notice it. The target is a plaintext aggregate and reveals nothing about
    ///         who withdrew or how much.
    function topUpBuffer() external returns (uint256 pulled) {
        if (address(yieldSource) == address(0)) revert YieldSourceNotSet();

        uint256 held = asset.balanceOf(address(this));
        uint256 buffered = held > ticketBudget ? held - ticketBudget : 0;
        if (buffered >= bufferTarget) revert BufferFull();

        uint256 want = bufferTarget - buffered;
        if (want > deployedPrincipal) want = deployedPrincipal;
        if (want == 0) revert InsufficientPrincipal();

        uint256 before = asset.balanceOf(address(this));
        yieldSource.withdraw(want, address(this));
        pulled = asset.balanceOf(address(this)) - before;

        // Same partial-fill discipline as `refillBuffer`: credit what actually arrived, or the
        // leftover principal gets mistaken for yield and paid out as a prize.
        deployedPrincipal -= pulled;
        _wrapIntoPool(pulled);

        emit BufferRefilled(pulled);
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

    /// @dev Validates that the venue is denominated in the pool's own asset. Without this a
    ///      mismatched source is permanently fatal: `invest` would hand USDC to a vault that wants
    ///      something else, revert, and the one-shot guard would mean it could never be
    ///      re-pointed. So the guard also relaxes — a live source may be replaced once every unit
    ///      of principal is home, which keeps "governance cannot move deployed principal" intact
    ///      while making a misconfiguration recoverable instead of terminal.
    function setYieldSource(address source) external onlyOwner {
        if (address(yieldSource) != address(0) && deployedPrincipal != 0) revert YieldSourceAlreadySet();
        if (source == address(0) || IYieldSource(source).asset() != address(asset)) revert AssetMismatch();
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

    /// @notice Set how far apart the two tracks' ticket reveals may be before `harvest` stops
    ///         trusting their ratio.
    function setSplitMaxSkew(uint64 skew) external onlyOwner {
        splitMaxSkew = skew;
        emit ConfigUpdated();
    }

    /// @notice Set how much underlying the pool keeps un-deployed so withdrawals settle at once.
    /// @dev    Anyone may then restore it with `topUpBuffer`; only the size is governed.
    function setBufferTarget(uint256 target) external onlyOwner {
        bufferTarget = target;
        emit BufferTargetSet(target);
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

    /// @notice What `user` was awarded by a round they claimed. Readable only by them.
    /// @dev    Zero until they claim, and zero afterwards unless they won — so its presence says
    ///         nothing. This is the handle the app decrypts to answer "did I win, and how much?".
    function awardOf(uint8 track, uint256 roundId, address user) external view returns (euint64) {
        return _award[track][roundId][user];
    }

    /// @notice Your encrypted ticket ranges on a track — your odds, readable only by you.
    function rangesOf(uint8 track, address user) external view returns (Range[] memory) {
        return _ranges[track][user];
    }

    function rangeCountOf(uint8 track, address user) external view returns (uint256) {
        return _ranges[track][user].length;
    }

    /// @notice Whether `user` may still reshape their ranges on a track this entry round — via
    ///         `restake`, a deposit that fills the list, or a Megapot opt-in/out.
    function canCompact(uint8 track, address user) external view returns (bool) {
        return _lastCompactRound[track][user] != _tracks[track].entryRound + 1;
    }

    /// @notice A track's encrypted ticket cursor. Its total is revealed once per round at close.
    function cursor(uint8 track) external view returns (euint64) {
        return _tracks[track].cursor;
    }

    /// @notice Encrypted cUSDC awaiting deployment into the yield source.
    function pendingDeploy() external view returns (euint64) {
        return _pendingDeploy;
    }

    function roundsLength(uint8 track) external view returns (uint256) {
        return _tracks[track].rounds.length;
    }

    function getRound(uint8 track, uint256 roundId) external view returns (Round memory) {
        return _tracks[track].rounds[roundId];
    }

    /// @notice A track's public aggregates: how many tickets are in play, what the next prize
    ///         holds, and which round new entries are tagged for.
    function trackInfo(uint8 track)
        external
        view
        returns (uint64 entryRound_, uint64 settledTickets_, uint64 prizeReserve_, uint256 rounds_)
    {
        Track storage t = _tracks[track];
        return (t.entryRound, t.settledTickets, t.prizeReserve, t.rounds.length);
    }

    /// @notice The share of the next harvest that would be routed to Megapot tickets, in bps.
    ///
    /// @dev    Exactly what `harvest` would compute right now, including every guard — so a zero
    ///         here means "the split is currently switched off", and the `SplitSkipped` reason on
    ///         the last harvest says why. The keeper and the app should show this rather than
    ///         recomputing the ratio themselves and disagreeing with the contract.
    function megapotShareBps() external view returns (uint16) {
        if (address(bridge) == address(0) || ticketAgent == bytes32(0)) return 0;

        Track storage main = _tracks[MAIN];
        Track storage mega = _tracks[MEGA];
        if (main.settledTickets == 0 || main.settledAt == 0 || mega.settledAt == 0) return 0;

        uint64 skew = main.settledAt > mega.settledAt
            ? main.settledAt - mega.settledAt
            : mega.settledAt - main.settledAt;
        if (skew > splitMaxSkew) return 0;

        uint256 megaTickets = mega.settledTickets;
        if (megaTickets > main.settledTickets) megaTickets = main.settledTickets;

        return uint16((megaTickets * 10_000) / main.settledTickets);
    }

    /// @notice The main track's prize reserve — the headline "next prize".
    function prizeReserve() external view returns (uint64) {
        return _tracks[MAIN].prizeReserve;
    }

    /// @notice The main track's revealed ticket total.
    function settledTickets() external view returns (uint64) {
        return _tracks[MAIN].settledTickets;
    }

    /// @notice The main track's entry round.
    function entryRound() external view returns (uint64) {
        return _tracks[MAIN].entryRound;
    }

    /// @notice How much un-deployed underlying backs immediate withdrawals, against the target
    ///         `topUpBuffer` restores. Public aggregates; neither reveals an individual position.
    function bufferStatus() external view returns (uint256 buffered, uint256 target) {
        uint256 held = asset.balanceOf(address(this));
        buffered = held > ticketBudget ? held - ticketBudget : 0;
        target = bufferTarget;
    }

    // ===================================================================== //
    //                             Internal                                  //
    // ===================================================================== //

    /// @dev How many trailing rounds per track a reshape will settle on the caller's behalf.
    ///
    ///      Rounds go `Claimable` → `Sweeping` → `Settled`, and `requestSweep` is permissionless,
    ///      so in practice at most one or two are ever `Claimable` at once. Three is slack.
    uint256 public constant MAX_AUTOCLAIM = 3;

    /// @dev Claim every live round `user` has not claimed, before their ranges are reshaped.
    ///
    ///      Withdrawing, re-staking and changing a Megapot allocation all move ticket ranges, and
    ///      a win is decided by whether the encrypted ticket falls inside one. Reshaping first
    ///      would silently destroy a prize the depositor had already won — invisibly, because
    ///      everything is encrypted, so they would just see an award of zero and read it as a
    ///      normal loss.
    ///
    ///      Settling first is also the better behaviour on its own terms: the award lands in
    ///      `_balance` *before* a withdrawal caps against it, so "withdraw everything" now
    ///      withdraws the winnings too, and `restake` folds them into the new range instead of
    ///      throwing them away.
    ///
    ///      Blocking these calls while a claim is pending would have been the cheaper fix, but
    ///      `claimWindow` is a keeper argument to `draw` — it would hand the keeper a lever to
    ///      freeze withdrawals, and withdrawing at any time is the one guarantee this pool makes
    ///      unconditionally.
    function _settleClaims(address user) private {
        for (uint8 track; track <= MEGA; ++track) {
            Round[] storage rounds = _tracks[track].rounds;
            uint256 n = rounds.length;
            uint256 floor_ = n > MAX_AUTOCLAIM ? n - MAX_AUTOCLAIM : 0;

            for (uint256 i = n; i > floor_; --i) {
                uint256 id = i - 1;
                if (rounds[id].state != RoundState.Claimable) continue;
                if (hasClaimed[track][id][user]) continue;
                _claim(track, id, user);
            }
        }
    }

    /// @dev Allocate `amount` tickets at the top of a track's cursor to `user`.
    function _allocate(uint8 track, address user, euint64 amount) private {
        Track storage t = _tracks[track];
        euint64 lower = t.cursor;
        euint64 upper = FHE.add(lower, amount);

        t.cursor = upper;
        FHE.allowThis(lower);
        FHE.allowThis(upper);
        FHE.allow(lower, user);
        FHE.allow(upper, user);

        _ranges[track][user].push(Range({lower: lower, upper: upper, round: t.entryRound}));
    }

    /// @dev Add `amount` tickets, folding the user's ranges into one first if the list is full.
    function _grow(uint8 track, address user, euint64 amount) private {
        if (_ranges[track][user].length >= MAX_RANGES) {
            _compact(track, user);
        } else {
            _allocate(track, user, amount);
        }
    }

    /// @dev Release every range the user holds on a track and issue a single fresh one covering
    ///      their whole balance. The released tickets become dead, which is why this is capped at
    ///      once per round: repeated compaction is the one cheap way to inflate the ticket space,
    ///      and an inflated space means most draws land on dead tickets and roll over.
    function _compact(uint8 track, address user) private {
        _rateLimit(track, user);
        delete _ranges[track][user];
        _allocate(track, user, _balance[user]);
    }

    /// @dev One reshape per track per round. Opting into and out of `MEGA` shares this budget with
    ///      compaction, because both mint dead tickets and both are otherwise free to repeat.
    function _rateLimit(uint8 track, address user) private {
        uint64 stamp = _tracks[track].entryRound + 1;
        if (_lastCompactRound[track][user] == stamp) revert AlreadyCompactedThisRound();
        _lastCompactRound[track][user] = stamp;
    }

    /// @dev Shrink the user's ranges from the top by `amount`, releasing exactly that many
    ///      tickets. Runs over every range because the cut point is encrypted; `MAX_RANGES`
    ///      keeps that bounded.
    function _releaseTickets(uint8 track, address user, euint64 amount) private {
        Range[] storage ranges = _ranges[track][user];
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
