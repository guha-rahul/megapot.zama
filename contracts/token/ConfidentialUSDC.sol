// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
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

    /// @notice Wrap `amount` of the underlying and authorise `operator` to move the result — the
    ///         two steps a depositor always needs, in one transaction.
    ///
    /// @dev    This has to live on the token. `setOperator` keys off `msg.sender`, so a helper
    ///         contract calling it would authorise an operator for *itself*, not for the caller.
    ///         Pair it with `wrapWithPermit` below and onboarding drops from three transactions to
    ///         one.
    function wrapAndAuthorize(address to, uint256 amount, address operator, uint48 until) public virtual {
        wrap(to, amount);
        _setOperator(msg.sender, operator, until);
    }

    /// @notice `wrapAndAuthorize`, with the ERC-20 approval supplied as an EIP-2612 signature.
    ///
    /// @dev    The permit is applied in a `try` block on purpose: an approval that already landed
    ///         — front-run, or replayed by an impatient wallet — reverts on the nonce, and that
    ///         must not take the wrap down with it. If the permit genuinely did not go through,
    ///         the `transferFrom` inside `wrap` reverts a moment later anyway.
    function wrapWithPermit(
        address to,
        uint256 amount,
        address operator,
        uint48 until,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external virtual {
        try IERC20Permit(underlying()).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        wrapAndAuthorize(to, amount, operator, until);
    }

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
