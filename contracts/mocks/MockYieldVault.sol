// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A plain ERC-4626 vault whose yield can be simulated by minting the underlying to it.
///         Stands in for Aave/Morpho/Moonwell in tests and on local networks.
/// @dev    `setWithdrawCap` models an illiquid venue that can only return part of a redemption,
///         which is the condition the pool's principal accounting has to survive.
contract MockYieldVault is ERC4626 {
    uint256 public withdrawCap = type(uint256).max;

    constructor(IERC20 asset_) ERC20("Mock Yield Vault", "myUSDC") ERC4626(asset_) {}

    function setWithdrawCap(uint256 cap) external {
        withdrawCap = cap;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 byShares = super.maxWithdraw(owner);
        return byShares < withdrawCap ? byShares : withdrawCap;
    }
}
