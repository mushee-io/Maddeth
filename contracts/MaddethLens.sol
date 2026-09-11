// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IInterestRateModel} from "./interfaces/IInterestRateModel.sol";

interface IMaddethPoolLensSource {
    function oracle() external view returns (address);
    function marketTotals(address asset)
        external
        view
        returns (uint256 totalSupplied, uint256 totalBorrowed, uint256 utilisation, uint256 reserves);
    function markets(address asset)
        external
        view
        returns (
            bool listed,
            bool paused,
            uint16 ltvBps,
            uint16 liquidationThresholdBps,
            uint16 liquidationBonusBps,
            uint16 reserveFactorBps,
            uint128 supplyCap,
            uint128 borrowCap,
            address rateModel
        );
    function supplied(address user, address asset) external view returns (uint256);
    function borrowed(address user, address asset) external view returns (uint256);
    function collateralEnabled(address user, address asset) external view returns (bool);
    function getAccountLiquidity(address user)
        external
        view
        returns (uint256 collateralUsd, uint256 borrowLimitUsd, uint256 liquidationLimitUsd, uint256 debtUsd);
    function healthFactor(address user) external view returns (uint256);
}

/// @title MaddethLens
/// @notice Read-only aggregation layer for the KUB Testnet frontend and indexers.
/// @dev Keeps presentation calculations out of the lending core and never mutates protocol state.
contract MaddethLens {
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    IMaddethPoolLensSource public immutable pool;

    struct MarketView {
        bool listed;
        bool paused;
        uint16 ltvBps;
        uint16 liquidationThresholdBps;
        uint16 liquidationBonusBps;
        uint16 reserveFactorBps;
        uint128 supplyCap;
        uint128 borrowCap;
        uint256 totalSupplied;
        uint256 totalBorrowed;
        uint256 availableLiquidity;
        uint256 utilisation;
        uint256 reserves;
        uint256 supplyApr;
        uint256 borrowApr;
        uint256 price;
        uint256 priceUpdatedAt;
    }

    struct AccountRiskView {
        uint256 collateralUsd;
        uint256 borrowLimitUsd;
        uint256 liquidationLimitUsd;
        uint256 debtUsd;
        uint256 healthFactor;
        uint256 availableBorrowUsd;
    }

    struct PositionView {
        uint256 walletBalance;
        uint256 suppliedAmount;
        uint256 borrowedAmount;
        bool collateralEnabled;
    }

    constructor(address pool_) {
        require(pool_ != address(0), "ZERO_POOL");
        pool = IMaddethPoolLensSource(pool_);
    }

    function marketView(address asset) external view returns (MarketView memory v) {
        address rateModel;
        (
            v.listed,
            v.paused,
            v.ltvBps,
            v.liquidationThresholdBps,
            v.liquidationBonusBps,
            v.reserveFactorBps,
            v.supplyCap,
            v.borrowCap,
            rateModel
        ) = pool.markets(asset);
        require(v.listed, "UNLISTED");

        (v.totalSupplied, v.totalBorrowed, v.utilisation, v.reserves) = pool.marketTotals(asset);
        v.availableLiquidity = IERC20Minimal(asset).balanceOf(address(pool));
        v.borrowApr = IInterestRateModel(rateModel).borrowRate(v.utilisation);
        v.supplyApr = v.borrowApr * v.utilisation / WAD;
        v.supplyApr = v.supplyApr * (BPS - v.reserveFactorBps) / BPS;
        (v.price, v.priceUpdatedAt) = IPriceOracle(pool.oracle()).getPrice(asset);
    }

    function accountRisk(address user) external view returns (AccountRiskView memory v) {
        (v.collateralUsd, v.borrowLimitUsd, v.liquidationLimitUsd, v.debtUsd) = pool.getAccountLiquidity(user);
        v.healthFactor = pool.healthFactor(user);
        v.availableBorrowUsd = v.borrowLimitUsd > v.debtUsd ? v.borrowLimitUsd - v.debtUsd : 0;
    }

    function positionView(address user, address asset) external view returns (PositionView memory v) {
        v.walletBalance = IERC20Minimal(asset).balanceOf(user);
        v.suppliedAmount = pool.supplied(user, asset);
        v.borrowedAmount = pool.borrowed(user, asset);
        v.collateralEnabled = pool.collateralEnabled(user, asset);
    }

    /// @notice Preview account risk after adding debt in one listed market.
    /// @return allowed True when the resulting debt stays inside the account borrow limit.
    /// @return newDebtUsd Total account debt after the requested borrow.
    /// @return newHealthFactor Liquidation health factor after the requested borrow.
    /// @return availableBorrowUsd Remaining borrow headroom after the requested borrow.
    function previewBorrow(address user, address asset, uint256 amount)
        external
        view
        returns (bool allowed, uint256 newDebtUsd, uint256 newHealthFactor, uint256 availableBorrowUsd)
    {
        require(amount > 0, "ZERO_AMOUNT");
        (bool listed,,,,,,,,) = pool.markets(asset);
        require(listed, "UNLISTED");

        (uint256 collateralUsd, uint256 borrowLimitUsd, uint256 liquidationLimitUsd, uint256 debtUsd) =
            pool.getAccountLiquidity(user);
        collateralUsd; // silence unused-variable warning while retaining tuple readability

        (uint256 price,) = IPriceOracle(pool.oracle()).getPrice(asset);
        require(price > 0, "INVALID_PRICE");
        uint256 amountUsd = amount * price / (10 ** IERC20Minimal(asset).decimals());
        newDebtUsd = debtUsd + amountUsd;
        allowed = newDebtUsd <= borrowLimitUsd;
        newHealthFactor = newDebtUsd == 0 ? type(uint256).max : liquidationLimitUsd * WAD / newDebtUsd;
        availableBorrowUsd = borrowLimitUsd > newDebtUsd ? borrowLimitUsd - newDebtUsd : 0;
    }
}
