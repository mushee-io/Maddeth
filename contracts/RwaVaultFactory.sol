// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IsolatedRwaVault} from "./IsolatedRwaVault.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {Ownable2Step} from "./utils/Ownable2Step.sol";

/// @notice Registry/factory for isolated Maddeth RWA credit vaults.
contract RwaVaultFactory is Ownable2Step {
    uint256 public constant MAX_VAULT_MATURITY = 5 * 365 days;
    uint256 public constant MAX_METADATA_URI_BYTES = 512;

    address[] public vaults;
    bool public creationPaused;
    mapping(address => bool) public approvedIssuer;
    mapping(address => string) public metadataURI;
    mapping(address => address) public vaultIssuer;
    mapping(address => bool) public isVault;

    event IssuerApproved(address indexed issuer, bool approved);
    event VaultCreationPaused(bool paused);
    event VaultCreated(address indexed vault, address indexed liquidityAsset, address indexed borrower, string metadataURI);

    constructor() Ownable2Step(msg.sender) {}

    function setIssuer(address issuer, bool approved) external onlyOwner {
        require(issuer != address(0), "ZERO_ISSUER");
        approvedIssuer[issuer] = approved;
        emit IssuerApproved(issuer, approved);
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit VaultCreationPaused(paused);
    }

    function createVault(address liquidityAsset, uint256 maturity, uint256 debtCap, string calldata uri)
        external
        returns (address vault)
    {
        require(!creationPaused, "CREATION_PAUSED");
        require(approvedIssuer[msg.sender], "ISSUER_NOT_APPROVED");
        require(liquidityAsset != address(0) && liquidityAsset.code.length > 0, "BAD_ASSET");
        require(IERC20Minimal(liquidityAsset).decimals() <= 36, "BAD_ASSET_DECIMALS");
        require(maturity > block.timestamp && maturity <= block.timestamp + MAX_VAULT_MATURITY, "BAD_MATURITY");
        require(debtCap > 0, "ZERO_DEBT_CAP");
        uint256 uriLength = bytes(uri).length;
        require(uriLength > 0 && uriLength <= MAX_METADATA_URI_BYTES, "BAD_METADATA");

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
