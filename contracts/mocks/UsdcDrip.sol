// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  UsdcDrip
/// @notice A one-click faucet for the exact token the pool accepts.
///
/// @dev    The pool takes Circle's Sepolia USDC and nothing else. That token cannot be minted —
///         Circle's own faucet is the only source — so a visitor's first step is to leave the
///         app, find an external faucet, pick the right network from a dropdown, and paste an
///         address. Several tokens on Sepolia are also called "USDC", so that detour is also
///         where people pick up the wrong one.
///
///         This contract removes the detour for small amounts: it holds a float of the *correct*
///         token and hands out a fixed drip per address, rate-limited so one visitor cannot empty
///         it. It mints nothing and has no privileged role — when the float runs out, `claim`
///         reverts `Empty` and the external faucet is still there.
///
///         Deliberately not ownable and with no rescue function. A faucet that someone can drain
///         back out is a faucet nobody can rely on, and there is nothing here worth rescuing:
///         every unit inside it is a testnet token somebody donated on purpose.
contract UsdcDrip {
    using SafeERC20 for IERC20;

    /// @notice The token handed out — must be the same one the pool accepts.
    IERC20 public immutable token;

    /// @notice How much one `claim` sends.
    uint256 public immutable amount;

    /// @notice How long an address must wait between claims.
    uint256 public constant COOLDOWN = 12 hours;

    /// @notice When each address last claimed. Zero means never.
    mapping(address => uint256) public lastClaim;

    event Dripped(address indexed to, uint256 amount);
    event Refilled(address indexed from, uint256 amount);

    error TooSoon(uint256 readyAt);
    error Empty();

    constructor(IERC20 token_, uint256 amount_) {
        token = token_;
        amount = amount_;
    }

    /// @notice Send yourself one drip. Reverts `TooSoon` inside the cooldown, `Empty` when dry.
    function claim() external {
        uint256 last = lastClaim[msg.sender];
        if (last != 0 && block.timestamp < last + COOLDOWN) revert TooSoon(last + COOLDOWN);
        if (token.balanceOf(address(this)) < amount) revert Empty();

        lastClaim[msg.sender] = block.timestamp;
        token.safeTransfer(msg.sender, amount);
        emit Dripped(msg.sender, amount);
    }

    /// @notice Top the float up. Permissionless — anyone may donate, nobody may take.
    function refill(uint256 value) external {
        token.safeTransferFrom(msg.sender, address(this), value);
        emit Refilled(msg.sender, value);
    }

    /// @notice How much is left to hand out.
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice How many drips remain at the current float.
    function dripsLeft() external view returns (uint256) {
        return token.balanceOf(address(this)) / amount;
    }

    /// @notice The timestamp `user` may claim again, or 0 if they can claim now.
    function readyAt(address user) external view returns (uint256) {
        uint256 last = lastClaim[user];
        if (last == 0) return 0;
        uint256 next = last + COOLDOWN;
        return block.timestamp >= next ? 0 : next;
    }
}
