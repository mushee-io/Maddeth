// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title LiquidationLabOracle
/// @notice TESTNET-ONLY oracle used by the isolated Maddeth liquidation lab.
/// @dev Anyone may toggle the bounded lab price shock. It cannot price arbitrary assets or affect the canonical pool.
contract LiquidationLabOracle is IPriceOracle {
    uint256 public constant NORMAL_COLLATERAL_PRICE = 10e18;
    uint256 public constant SHOCKED_COLLATERAL_PRICE = 8e18;
    uint256 public constant DEBT_ASSET_PRICE = 1e18;

    address public immutable collateralAsset;
    address public immutable debtAsset;
    bool public shocked;
    uint256 public updatedAt;

    event ShockStateChanged(bool shocked, uint256 collateralPrice, address indexed caller);

    constructor(address collateralAsset_, address debtAsset_) {
        require(collateralAsset_ != address(0) && debtAsset_ != address(0), "ZERO_ASSET");
        require(collateralAsset_ != debtAsset_, "SAME_ASSET");
        collateralAsset = collateralAsset_;
        debtAsset = debtAsset_;
        updatedAt = block.timestamp;
    }

    /// @notice Toggle between the fixed $10 normal price and fixed $8 shocked price.
    /// @dev Public by design because this contract is only for the isolated KUB Testnet lab.
    function setShock(bool enabled) external {
        shocked = enabled;
        updatedAt = block.timestamp;
        emit ShockStateChanged(enabled, enabled ? SHOCKED_COLLATERAL_PRICE : NORMAL_COLLATERAL_PRICE, msg.sender);
    }

    function getPrice(address asset) external view returns (uint256 price, uint256 timestamp) {
        if (asset == collateralAsset) {
            return (shocked ? SHOCKED_COLLATERAL_PRICE : NORMAL_COLLATERAL_PRICE, updatedAt);
        }
        if (asset == debtAsset) {
            return (DEBT_ASSET_PRICE, updatedAt);
        }
        revert("UNSUPPORTED_ASSET");
    }
}
