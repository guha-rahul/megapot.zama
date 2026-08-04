// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/// @title  ConfidentialUSDC
/// @notice A confidential (ERC-7984) wrapper around a public ERC-20 such as USDC. Balances and
///         transfer amounts are FHE ciphertexts; only the holder can decrypt their own balance.
///
///         This is what makes MegaPot deposits and withdrawals confidential end to end: wrapping
///         is a public, one-off, amount-of-your-choosing action that is not tied to any pool
///         action, and everything the pool then does with the tokens is encrypted.
///
/// @dev    Unwrapping is asynchronous by construction: `unwrap` burns the confidential amount and
///         marks it publicly decryptable, then anyone submits the cleartext with its KMS proof to
///         `finalizeUnwrap`, which releases the underlying.
contract ConfidentialUSDC is ERC7984, ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(
        IERC20 underlying_,
        string memory name_,
        string memory symbol_,
        string memory uri_
    ) ERC7984(name_, symbol_, uri_) ERC7984ERC20Wrapper(underlying_) {}

    function decimals() public view virtual override(ERC7984, ERC7984ERC20Wrapper) returns (uint8) {
        return ERC7984ERC20Wrapper.decimals();
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC7984, ERC7984ERC20Wrapper) returns (bool) {
        return ERC7984ERC20Wrapper.supportsInterface(interfaceId);
    }

    function _update(address from, address to, euint64 amount) internal virtual override(ERC7984, ERC7984ERC20Wrapper) returns (euint64) {
        return ERC7984ERC20Wrapper._update(from, to, amount);
    }
}
