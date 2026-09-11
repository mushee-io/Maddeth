// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IsolatedRwaVault} from "./IsolatedRwaVault.sol";

/// @notice Registry/factory for isolated Maddeth RWA credit vaults.
contract RwaVaultFactory {
    address public owner;
    address[] public vaults;
    mapping(address => bool) public approvedIssuer;
    mapping(address => string) public metadataURI;
    mapping(address => address) public vaultIssuer;
    mapping(address => bool) public isVault;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event IssuerApproved(address indexed issuer, bool approved);
    event VaultCreated(address indexed vault, address indexed liquidityAsset, address indexed borrower, string metadataURI);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setIssuer(address issuer, bool approved) external onlyOwner {
        require(issuer != address(0), "ZERO_ISSUER");
        approvedIssuer[issuer] = approved;
        emit IssuerApproved(issuer, approved);
    }

    function createVault(address liquidityAsset, uint256 maturity, uint256 debtCap, string calldata uri)
        external
        returns (address vault)
    {
        require(approvedIssuer[msg.sender], "ISSUER_NOT_APPROVED");
        require(liquidityAsset != address(0), "ZERO_ASSET");
        require(bytes(uri).length > 0, "EMPTY_METADATA");

        IsolatedRwaVault v = new IsolatedRwaVault(liquidityAsset, msg.sender, msg.sender, maturity, debtCap);
        vault = address(v);
        vaults.push(vault);
        isVault[vault] = true;
        vaultIssuer[vault] = msg.sender;
        metadataURI[vault] = uri;
        emit VaultCreated(vault, liquidityAsset, msg.sender, uri);
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }
}
