// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IYieldSource} from "./IYieldSource.sol";

/// @title  ERC4626YieldSource
/// @notice Routes MegaPot's pooled principal into any ERC-4626 vault — which on Base/Ethereum
///         covers the usual suspects (Aave's static aTokens, Morpho Blue vaults, Moonwell, Euler).
///         The pool's yield, and therefore the prize, is whatever this vault earns above the
///         principal MegaPot deposited.
/// @dev    Only the `owner` (the MegaPot instance) can move funds. There is no arbitrary-call
///         surface: `deposit` and `withdraw` are the entire API.
contract ERC4626YieldSource is IYieldSource, Ownable {
    using SafeERC20 for IERC20;

    IERC4626 public immutable vault;
    IERC20 private immutable _asset;

    error AssetMismatch();

    /// @param expectedAsset The token the pool will hand this source. Passing it in is what makes
    ///        the deployed adapter self-describing: a vault denominated in something else is
    ///        rejected here, at construction, rather than at the first `invest` — by which point
    ///        it is the pool's problem. `MegaPot.setYieldSource` checks the same thing again on
    ///        its side, because the two contracts are deployed by different steps.
    constructor(IERC4626 vault_, address owner_, address expectedAsset) Ownable(owner_) {
        address a = vault_.asset();
        if (a == address(0) || a != expectedAsset) revert AssetMismatch();

        vault = vault_;
        _asset = IERC20(a);
    }

    /// @inheritdoc IYieldSource
    function asset() external view returns (address) {
        return address(_asset);
    }

    /// @inheritdoc IYieldSource
    function deposit(uint256 amount) external onlyOwner {
        _asset.safeTransferFrom(msg.sender, address(this), amount);
        _asset.forceApprove(address(vault), amount);
        vault.deposit(amount, address(this));
    }

    /// @inheritdoc IYieldSource
    function withdraw(uint256 amount, address to) external onlyOwner returns (uint256 sent) {
        uint256 available = vault.maxWithdraw(address(this));
        sent = amount < available ? amount : available;
        if (sent == 0) return 0;
        vault.withdraw(sent, to, address(this));
    }

    /// @inheritdoc IYieldSource
    function totalAssets() external view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(address(this)));
    }
}
