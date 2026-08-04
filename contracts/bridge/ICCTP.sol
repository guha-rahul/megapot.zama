// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Circle CCTP V2. Signatures read from the verified implementations behind the proxies:
///
///           TokenMessengerV2      testnets 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
///                                 mainnets 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d
///           MessageTransmitterV2  testnets 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
///                                 mainnets 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
///
///         Domains: Ethereum = 0, Base = 6.
///
/// @dev    Why CCTP rather than a keeper wiring funds across by hand: `depositForBurn` burns the
///         USDC and names `mintRecipient` *at burn time*. Circle's attestation only mints to that
///         address, so the off-chain relayer can stall the transfer but can never redirect it.
///         The keeper is a liveness dependency, not a custodian.
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

interface IMessageTransmitterV2 {
    /// @notice Called on the destination chain with Circle's attestation to mint the USDC.
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);

    function localDomain() external view returns (uint32);
}
