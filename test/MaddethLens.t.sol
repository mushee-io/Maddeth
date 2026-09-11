// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {MaddethLens} from "../contracts/MaddethLens.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockPriceOracle} from "../contracts/mocks/MockPriceOracle.sol";

contract MaddethLensTest is TestBase {
    MaddethPool internal pool;
    MaddethLens internal lens;
    InterestRateModel internal rateModel;
    MockPriceOracle internal oracle;
    MockERC20 internal kub;
    MockERC20 internal usdc;

    address internal lender = address(0xA11CE);
    address internal borrower = address(0xB0B);

    function setUp() public {
        oracle = new MockPriceOracle();
        rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        pool = new MaddethPool(address(oracle));
        lens = new MaddethLens(address(pool));
        kub = new MockERC20("Mock KUB", "mKUB", 18);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);

        oracle.setPrice(address(kub), 10e18);
        oracle.setPrice(address(usdc), 1e18);

        pool.configureMarket(
            address(kub),
            MaddethPool.MarketConfig({
                listed: true,
                paused: false,
                ltvBps: 7_000,
                liquidationThresholdBps: 8_000,
                liquidationBonusBps: 500,
                reserveFactorBps: 1_000,
                supplyCap: uint128(1_000_000 ether),
                borrowCap: uint128(500_000 ether),
                rateModel: address(rateModel)
            })
        );
        pool.configureMarket(
            address(usdc),
            MaddethPool.MarketConfig({
                listed: true,
                paused: false,
                ltvBps: 8_000,
                liquidationThresholdBps: 8_500,
                liquidationBonusBps: 400,
                reserveFactorBps: 1_000,
                supplyCap: uint128(10_000_000e6),
                borrowCap: uint128(8_000_000e6),
                rateModel: address(rateModel)
            })
        );

        usdc.mint(lender, 1_000_000e6);
        vm.startPrank(lender);
        usdc.approve(address(pool), type(uint256).max);
        pool.supply(address(usdc), 1_000_000e6);
        vm.stopPrank();

        kub.mint(borrower, 100 ether);
        vm.startPrank(borrower);
        kub.approve(address(pool), type(uint256).max);
        pool.supply(address(kub), 100 ether);
        pool.setCollateral(address(kub), true);
        vm.stopPrank();
    }

    function testMarketViewReturnsLiveEconomics() public view {
        MaddethLens.MarketView memory v = lens.marketView(address(usdc));
        assertTrue(v.listed, "market missing");
        assertEq(v.totalSupplied, 1_000_000e6, "wrong supply");
        assertEq(v.availableLiquidity, 1_000_000e6, "wrong cash");
        assertEq(v.price, 1e18, "wrong price");
        assertTrue(v.borrowApr >= 0.02e18, "borrow rate below base");
    }

    function testAccountRiskAndBorrowPreview() public {
        MaddethLens.AccountRiskView memory risk = lens.accountRisk(borrower);
        assertEq(risk.collateralUsd, 1_000e18, "wrong collateral value");
        assertEq(risk.borrowLimitUsd, 700e18, "wrong borrow limit");
        assertEq(risk.debtUsd, 0, "unexpected debt");

        (bool allowed, uint256 debtUsd, uint256 hf, uint256 remaining) =
            lens.previewBorrow(borrower, address(usdc), 500e6);
        assertTrue(allowed, "safe borrow rejected");
        assertEq(debtUsd, 500e18, "wrong preview debt");
        assertEq(hf, 1.6e18, "wrong preview hf");
        assertEq(remaining, 200e18, "wrong remaining borrow");

        (allowed,, hf,) = lens.previewBorrow(borrower, address(usdc), 800e6);
        assertTrue(!allowed, "unsafe borrow allowed");
        assertEq(hf, 1e18, "wrong liquidation preview");
    }

    function testPositionViewTracksWalletSupplyBorrowAndCollateral() public {
        MaddethLens.PositionView memory beforeBorrow = lens.positionView(borrower, address(kub));
        assertEq(beforeBorrow.suppliedAmount, 100 ether, "wrong supplied balance");
        assertTrue(beforeBorrow.collateralEnabled, "collateral not enabled");

        vm.prank(borrower);
        pool.borrow(address(usdc), 250e6);

        MaddethLens.PositionView memory debtPosition = lens.positionView(borrower, address(usdc));
        assertEq(debtPosition.borrowedAmount, 250e6, "wrong debt balance");
        assertEq(debtPosition.walletBalance, 250e6, "wrong wallet balance");
    }
}
