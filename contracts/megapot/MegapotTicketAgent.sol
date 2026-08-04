// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ITokenMessengerV2} from "../bridge/ICCTP.sol";
import {IBaseJackpot} from "./IBaseJackpot.sol";

/// @title  MegapotTicketAgent
/// @notice MegaPot's arm on Base. It buys real Megapot lottery tickets with harvested yield,
///         holds the resulting position in its own name, claims what it wins, and bridges the
///         winnings back to the confidential pool on Ethereum.
///
///         This exists because the two halves cannot share a chain: the Zama Protocol is
///         deployed on Ethereum (and Polygon Amoy), Megapot only on Base. The confidential
///         ledger stays where FHE works; the lottery position lives where the lottery is.
///
/// @dev    Everything this contract does is public — ticket purchases, winnings, bridge
///         transfers. That costs no privacy: it all happens at *pool aggregate* granularity,
///         which MegaPot already publishes in the clear. Which depositor ends up with the money
///         is decided later, on the Ethereum side, under encryption.
///
///         The agent can only ever move value along one path:
///
///             pay token in ──► Megapot tickets ──► winnings ──► CCTP burn to `homeRecipient`
///
///         `homeRecipient` is immutable and CCTP mints only to the address named at burn time,
///         so a compromised keeper can stall the flow but cannot redirect a single unit of it.
contract MegapotTicketAgent is Ownable {
    using SafeERC20 for IERC20;

    /// @notice CCTP V2 finality thresholds. 2000 = hard finality (slow, no fee).
    uint32 public constant FINALITY_STANDARD = 2000;

    // --------------------------------------------------------------------- //
    //                            Immutables                                  //
    // --------------------------------------------------------------------- //

    /// @notice The live Megapot jackpot on this chain.
    IBaseJackpot public immutable jackpot;
    /// @notice The token the jackpot settles in — real USDC on Base mainnet, a test token on
    ///         Base Sepolia. Read from the jackpot itself so it can never drift.
    IERC20 public immutable payToken;

    /// @notice CCTP TokenMessengerV2, or zero to disable bridging (testnet, where the jackpot's
    ///         token is not CCTP-transferable).
    ITokenMessengerV2 public immutable tokenMessenger;
    /// @notice CCTP domain of the chain the confidential pool lives on (0 = Ethereum).
    uint32 public immutable homeDomain;
    /// @notice Where winnings land at home, as bytes32. Immutable — this is the safety property.
    bytes32 public immutable homeRecipient;

    // --------------------------------------------------------------------- //
    //                          Wiring / accounting                           //
    // --------------------------------------------------------------------- //

    address public keeper;
    /// @notice Referrer credited on ticket purchases; earns `jackpot.referralFeeBps()` of spend.
    /// @dev    The live jackpot rejects `referrer == recipient` with "Cannot refer yourself", so
    ///         this can never be the agent itself — a pool cannot rebate its own house edge.
    ///         Zero (the default) is accepted and simply forgoes the fee.
    address public referrer;

    /// @notice Lifetime pay-token spent on tickets.
    uint256 public totalSpent;
    /// @notice Lifetime winnings withdrawn from the jackpot.
    uint256 public totalWon;
    /// @notice Lifetime referral fees withdrawn.
    uint256 public totalReferralFees;
    /// @notice Lifetime value burned to CCTP for the trip home.
    uint256 public totalBridged;

    event KeeperSet(address indexed keeper);
    event ReferrerSet(address indexed referrer);
    event TicketsBought(uint256 amount, uint256 ticketsBps);
    event WinningsClaimed(uint256 amount);
    event ReferralFeesClaimed(uint256 amount);
    event BridgedHome(uint256 amount, uint32 destinationDomain, bytes32 recipient);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error OnlyKeeper();
    error ZeroAmount();
    error PurchasingDisabled();
    error JackpotLocked();
    error InsufficientBalance();
    error BridgingDisabled();
    error NotBridgeable();
    error CannotReferSelf();

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert OnlyKeeper();
        _;
    }

    /// @param jackpot_        Megapot on this chain.
    /// @param tokenMessenger_ CCTP TokenMessengerV2, or zero to run without a bridge.
    /// @param homeDomain_     CCTP domain of the pool's chain (0 = Ethereum).
    /// @param homeRecipient_  The `PrizeInbox` on the pool's chain, left-padded to bytes32.
    constructor(
        IBaseJackpot jackpot_,
        ITokenMessengerV2 tokenMessenger_,
        uint32 homeDomain_,
        bytes32 homeRecipient_,
        address governance,
        address keeper_
    ) Ownable(governance) {
        jackpot = jackpot_;
        payToken = IERC20(jackpot_.token());
        tokenMessenger = tokenMessenger_;
        homeDomain = homeDomain_;
        homeRecipient = homeRecipient_;
        keeper = keeper_;
        referrer = address(0);
    }

    // ===================================================================== //
    //                              Playing                                  //
    // ===================================================================== //

    /// @notice Spend `amount` of the pay token on Megapot tickets, held in this contract's name.
    /// @dev    Reverts early on the two conditions the jackpot enforces, so a keeper gets a clear
    ///         error rather than an opaque one from inside the proxy.
    function buyTickets(uint256 amount) external onlyKeeper returns (uint256 ticketsBps) {
        if (amount == 0) revert ZeroAmount();
        if (!jackpot.allowPurchasing()) revert PurchasingDisabled();
        if (jackpot.jackpotLock()) revert JackpotLocked();
        if (payToken.balanceOf(address(this)) < amount) revert InsufficientBalance();

        (uint256 before,,) = jackpot.usersInfo(address(this));

        payToken.forceApprove(address(jackpot), amount);
        jackpot.purchaseTickets(referrer, amount, address(this));
        payToken.forceApprove(address(jackpot), 0);

        (uint256 afterBps,,) = jackpot.usersInfo(address(this));
        ticketsBps = afterBps - before;
        totalSpent += amount;

        emit TicketsBought(amount, ticketsBps);
    }

    /// @notice Pull whatever the jackpot owes this contract. Permissionless — it can only move
    ///         value *into* the agent, and from there the only exit is the bridge home.
    function claimWinnings() external returns (uint256 amount) {
        (, uint256 owed,) = jackpot.usersInfo(address(this));
        if (owed == 0) revert ZeroAmount();

        uint256 before = payToken.balanceOf(address(this));
        jackpot.withdrawWinnings();
        amount = payToken.balanceOf(address(this)) - before;

        totalWon += amount;
        emit WinningsClaimed(amount);
    }

    /// @notice Claim referral fees this agent has accrued as *someone else's* referrer — e.g. if
    ///         another integrator points their purchases here. Comes home the same way winnings do.
    function claimReferralFees() external returns (uint256 amount) {
        if (jackpot.referralFeesClaimable(address(this)) == 0) revert ZeroAmount();

        uint256 before = payToken.balanceOf(address(this));
        jackpot.withdrawReferralFees();
        amount = payToken.balanceOf(address(this)) - before;

        totalReferralFees += amount;
        emit ReferralFeesClaimed(amount);
    }

    // ===================================================================== //
    //                            Bridge home                                //
    // ===================================================================== //

    /// @notice Burn `amount` of the pay token to CCTP, to be minted to `homeRecipient` on the
    ///         pool's chain. The keeper then fetches Circle's attestation and calls
    ///         `receiveMessage` there; the destination is fixed here and cannot be changed.
    /// @param maxFee Cap on CCTP's fee. Zero is correct for standard (hard-finality) transfers.
    function bridgeHome(uint256 amount, uint256 maxFee) external onlyKeeper {
        if (address(tokenMessenger) == address(0)) revert BridgingDisabled();
        if (amount == 0) revert ZeroAmount();
        if (payToken.balanceOf(address(this)) < amount) revert InsufficientBalance();

        payToken.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurn(
            amount, homeDomain, homeRecipient, address(payToken), bytes32(0), maxFee, FINALITY_STANDARD
        );
        payToken.forceApprove(address(tokenMessenger), 0);

        totalBridged += amount;
        emit BridgedHome(amount, homeDomain, homeRecipient);
    }

    /// @notice Claim everything owed and send it home in one keeper transaction.
    function harvestAndBridge(uint256 maxFee) external onlyKeeper returns (uint256 bridged) {
        (, uint256 owed,) = jackpot.usersInfo(address(this));
        if (owed > 0) {
            uint256 before = payToken.balanceOf(address(this));
            jackpot.withdrawWinnings();
            uint256 got = payToken.balanceOf(address(this)) - before;
            totalWon += got;
            emit WinningsClaimed(got);
        }
        if (jackpot.referralFeesClaimable(address(this)) > 0) {
            uint256 before = payToken.balanceOf(address(this));
            jackpot.withdrawReferralFees();
            uint256 got = payToken.balanceOf(address(this)) - before;
            totalReferralFees += got;
            emit ReferralFeesClaimed(got);
        }

        bridged = payToken.balanceOf(address(this));
        if (bridged == 0) return 0;
        if (address(tokenMessenger) == address(0)) revert BridgingDisabled();

        payToken.forceApprove(address(tokenMessenger), bridged);
        tokenMessenger.depositForBurn(
            bridged, homeDomain, homeRecipient, address(payToken), bytes32(0), maxFee, FINALITY_STANDARD
        );
        payToken.forceApprove(address(tokenMessenger), 0);

        totalBridged += bridged;
        emit BridgedHome(bridged, homeDomain, homeRecipient);
    }

    // ===================================================================== //
    //                          Admin / views                                //
    // ===================================================================== //

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice Set the referrer credited on this agent's purchases.
    /// @dev    Cannot be the agent itself: the live jackpot reverts with "Cannot refer yourself",
    ///         verified against Base Sepolia. Pass zero to forgo the fee.
    function setReferrer(address referrer_) external onlyOwner {
        if (referrer_ == address(this)) revert CannotReferSelf();
        referrer = referrer_;
        emit ReferrerSet(referrer_);
    }

    /// @notice Escape hatch for the case the bridge cannot carry the pay token — which is exactly
    ///         the situation on Base Sepolia, where Megapot settles in its own test token rather
    ///         than CCTP-transferable USDC. Governance-only.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    /// @notice Whether `bridgeHome` can work here: CCTP must be wired and must be able to carry
    ///         the token the jackpot actually pays out in.
    function bridgeEnabled() external view returns (bool) {
        return address(tokenMessenger) != address(0);
    }

    /// @notice This agent's share of the current round, in basis points of all tickets sold.
    function ticketsHeldBps() external view returns (uint256 bps) {
        (bps,,) = jackpot.usersInfo(address(this));
    }

    /// @notice What the jackpot currently owes this agent.
    function claimable() external view returns (uint256 amount) {
        (, amount,) = jackpot.usersInfo(address(this));
    }

    /// @notice Realised return on everything staked so far, in basis points. Below 10,000 means
    ///         the house edge is winning — which, over a small number of rounds, it usually is.
    ///         The live edge is `jackpot.feeBps()`: 1,500 on Base Sepolia, 3,000 on Base mainnet.
    function realisedReturnBps() external view returns (uint256) {
        if (totalSpent == 0) return 0;
        return ((totalWon + totalReferralFees) * 10_000) / totalSpent;
    }

    /// @notice When the current round may be settled by anyone calling `jackpot.runJackpot`.
    function roundEndsAt() external view returns (uint256) {
        return jackpot.lastJackpotEndTime() + jackpot.roundDurationInSeconds();
    }
}
