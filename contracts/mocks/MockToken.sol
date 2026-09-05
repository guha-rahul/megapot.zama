// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test ERC-20 with a caller-chosen decimal count.
///
/// @dev    Exists so the pool's constructor guards can be tested against a token it must refuse.
///         An 18-decimal underlying gives the ERC-7984 wrapper a rate of 10^12, which would
///         silently mix the pool's public and confidential unit scales — see `MegaPot`'s
///         constructor.
contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
