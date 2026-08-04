// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  IBaseJackpot
/// @notice The live Megapot jackpot on Base. Signatures taken verbatim from the verified
///         implementation behind the proxy, not from documentation:
///
///           Base Sepolia  proxy 0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De
///                          impl 0x271ba7aC4CD936aabeE15B5b16C1695407912333
///           Base mainnet  proxy 0xbEDd4F2beBE9E3E636161E644759f3cbe3d51B95
///
/// @dev    Tickets are pooled accounting, not NFTs: `purchaseTickets` credits `recipient` with
///         `ticketsPurchasedTotalBps`, a share of the round. That makes a *contract* a
///         first-class participant — it needs no NFT-receiver hook and no custody dance, and it
///         withdraws its own winnings with `withdrawWinnings()`.
///
///         This is a different, older generation from the number-picking `Jackpot`
///         (0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2, ticket NFTs) that megayield integrates.
///         We target this one because it is the only Megapot deployed on a testnet, so the whole
///         flow can be exercised for real before it touches mainnet — and the interface is
///         identical on both networks.
interface IBaseJackpot {
    /// @notice Buy `value` worth of tickets, credited to `recipient`.
    /// @param referrer  Earns `referralFeeBps` of the spend, claimable via `withdrawReferralFees`.
    /// @param value     Amount of `token()` to spend. Must be approved to the jackpot first.
    /// @param recipient Who the tickets belong to. May be a contract.
    function purchaseTickets(address referrer, uint256 value, address recipient) external;

    /// @notice Withdraw `usersInfo(msg.sender).winningsClaimable` to msg.sender.
    function withdrawWinnings() external;

    /// @notice Withdraw `referralFeesClaimable(msg.sender)` to msg.sender.
    function withdrawReferralFees() external;

    /// @notice Settle the round once `lastJackpotEndTime + roundDurationInSeconds` has passed.
    /// @dev    Randomness comes from Pyth Entropy, so this is payable — send `getJackpotFee()`.
    function runJackpot(bytes32 userRandomNumber) external payable;

    /// @notice Per-participant state. `winningsClaimable` is what `withdrawWinnings` would pay.
    function usersInfo(address user)
        external
        view
        returns (uint256 ticketsPurchasedTotalBps, uint256 winningsClaimable, bool active);

    function referralFeesClaimable(address referrer) external view returns (uint256);

    /// @notice The ERC-20 the jackpot settles in. Real USDC on mainnet; a test token on Sepolia.
    function token() external view returns (address);

    function ticketPrice() external view returns (uint256);
    function tokenDecimals() external view returns (uint256);
    function lastJackpotEndTime() external view returns (uint256);
    function roundDurationInSeconds() external view returns (uint256);
    function jackpotLock() external view returns (bool);
    function allowPurchasing() external view returns (bool);
    function lastWinnerAddress() external view returns (address);
    function lpPoolTotal() external view returns (uint256);
    function userPoolTotal() external view returns (uint256);
    function ticketCountTotalBps() external view returns (uint256);
    /// @notice The house edge in basis points, taken from every ticket purchase.
    function feeBps() external view returns (uint256);
    function referralFeeBps() external view returns (uint256);
    /// @notice Native-token fee `runJackpot` must be paid to cover the Pyth Entropy request.
    function getJackpotFee() external view returns (uint256);
}
