// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IsolatedRwaVault} from "./IsolatedRwaVault.sol";

/// @notice Registry/factory for isolated Maddeth RWA credit vaults.
contract RwaVaultFactory {
    address public owner;
    address[] public vaults;
    mapping(address => bool) public approvedIssuer;
    mapping(address => string) public metadataURI;

    event IssuerApproved(address indexed issuer, bool approved);
    event VaultCreated(address indexed vault, address indexed liquidityAsset, address indexed borrower, string metadataURI);

    modifier onlyOwner(){ require(msg.sender == owner, "NOT_OWNER"); _; }

    constructor(){ owner = msg.sender; }

    function setIssuer(address issuer, bool approved) external onlyOwner {
        approvedIssuer[issuer] = approved;
        emit IssuerApproved(issuer, approved);
    }

    function createVault(address liquidityAsset, uint256 maturity, uint256 debtCap, string calldata uri) external returns (address vault) {
        require(approvedIssuer[msg.sender], "ISSUER_NOT_APPROVED");
        IsolatedRwaVault v = new IsolatedRwaVault(liquidityAsset, msg.sender, maturity, debtCap);
        vault = address(v);
        vaults.push(vault);
        metadataURI[vault] = uri;
        emit VaultCreated(vault, liquidityAsset, msg.sender, uri);
    }

    function vaultCount() external view returns (uint256){ return vaults.length; }
}
