// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  IYieldSource
/// @notice The minimal surface MegaPot needs from a yield venue. Deliberately narrow: the pool
///         can only move its own principal in and out, never make arbitrary calls.
interface IYieldSource {
    /// @notice The underlying token this source accepts (e.g. USDC).
    function asset() external view returns (address);

    /// @notice Pull `amount` of `asset` from the caller and put it to work.
    function deposit(uint256 amount) external;

    /// @notice Redeem up to `amount` of `asset` and send it to `to`. Returns what was sent.
    function withdraw(uint256 amount, address to) external returns (uint256);

    /// @notice Current value of everything this source holds, denominated in `asset`.
    function totalAssets() external view returns (uint256);
}
