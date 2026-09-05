// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MegaPot} from "./MegaPot.sol";

/// @title  PrizeInbox
/// @notice Where Megapot winnings land when they come home from Base, and the only thing they
///         can become.
///
/// @dev    This contract exists to make the no-loss rule structural rather than procedural.
///         Winnings arrive as a CCTP mint, which needs a fixed destination address chosen at
///         burn time. If that destination were the pool itself, the arriving USDC would be
///         indistinguishable from freshly-unwrapped deposits sitting in the pool waiting to be
///         invested — and one keeper mistake would turn depositors' principal into prize money,
///         or prize money into principal.
///
///         So winnings land here instead. `flush()` is permissionless and has exactly one
///         destination: `pot.fundPrize` on the **Megapot track**, which pulls the USDC and wraps
///         it into that track's prize reserve. There is no owner, no rescue function, no other
///         exit — and because the track is fixed at compile time, Megapot winnings can only ever
///         become the prize the opted-in depositors are playing for.
contract PrizeInbox {
    using SafeERC20 for IERC20;

    MegaPot public immutable pot;
    IERC20 public immutable asset;

    event Flushed(uint256 amount);

    error NothingToFlush();

    constructor(MegaPot pot_) {
        pot = pot_;
        asset = IERC20(pot_.asset());
    }

    /// @notice Push everything held here into the Megapot track's prize reserve. Anyone may call
    ///         it — the destination is not the caller's to choose.
    function flush() external returns (uint256 amount) {
        amount = asset.balanceOf(address(this));
        if (amount == 0) revert NothingToFlush();

        asset.forceApprove(address(pot), amount);
        pot.fundPrize(pot.MEGA(), amount);

        emit Flushed(amount);
    }

    /// @notice Winnings sitting here that have not been folded into the prize yet.
    function pending() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }
}
