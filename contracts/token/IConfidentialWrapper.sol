// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {euint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";

/// @notice `IERC7984ERC20Wrapper` plus the proof-free overloads that `ERC7984ERC20Wrapper`
///         implements but the draft interface does not declare. MegaPot needs them because it
///         passes ciphertext handles it computed itself, not freshly proven user inputs.
interface IConfidentialWrapper is IERC7984ERC20Wrapper {
    /// @dev Unwrap an already-authorised ciphertext handle. Returns the unwrap request id, which
    ///      is the handle of the amount actually burned.
    function unwrap(address from, address to, euint64 amount) external returns (bytes32);
}
