// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Megapot's Base Sepolia settlement token, `TestTokenUSDC` at
///         0xA4253E7C13525287C56550b8708100f93E60509f, exposes a permissionless `mint`. This is
///         the interface for that faucet — it is a real deployed contract, not a stand-in, and it
///         is what makes the Megapot leg testable without begging for testnet funds.
interface IMintableTestToken {
    function mint(address to, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}
