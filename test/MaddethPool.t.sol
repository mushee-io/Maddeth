// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockPriceOracle} from "../contracts/mocks/MockPriceOracle.sol";

contract MaddethPoolTest is TestBase {
    MaddethPool internal pool;
    InterestRateModel internal rateModel;
    MockPriceOracle internal oracle;
    MockERC20 internal kub;
    MockERC20 internal usdc;

    address internal lender = address(0xA11CE);
    address internal borrower = address(0xB0B);
    address internal liquidator = address(0xCAFE);

    function setUp() public {
        oracle = new MockPriceOracle();
        rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        pool = new MaddethPool(address(oracle));
        kub = new MockERC20("Mock KUB", "mKUB", 18);
        usdc = new MockERC20("Mock USD Coin", "mUSDC", 6);

        oracle.setPrice(address(kub), 10e18);
        oracle.setPrice(address(usdc), 1e18);

        pool.configureMarket(address(kub), MaddethPool.MarketConfig({listed: true, paused: false, ltvBps: 7_500, liquidationThresholdBps: 8_000, liquidationBonusBps: 500, reserveFactorBps: 1_000, supplyCap: uint128(10_000_000 ether), borrowCap: uint128(5_000_000 ether), rateModel: address(rateModel)}));
        pool.configureMarket(address(usdc), MaddethPool.MarketConfig({listed: true, paused: false, ltvBps: 8_000, liquidationThresholdBps: 8_500, liquidationBonusBps: 500, reserveFactorBps: 1_000, supplyCap: uint128(10_000_000e6), borrowCap: uint128(5_000_000e6), rateModel: address(rateModel)}));

        usdc.mint(lender, 1_000_000e6);
        kub.mint(borrower, 1_000 ether);
        usdc.mint(liquidator, 100_000e6);

        vm.startPrank(lender);
        usdc.approve(address(pool), type(uint256).max);
        pool.supply(address(usdc), 1_000_000e6);
        vm.stopPrank();

        vm.startPrank(borrower);
        kub.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        pool.supply(address(kub), 100 ether);
        pool.setCollateral(address(kub), true);
        vm.stopPrank();

        vm.prank(liquidator);
        usdc.approve(address(pool), type(uint256).max);
    }

    function testSupplyBorrowRepayWithdraw() public {
        vm.startPrank(borrower);
        pool.borrow(address(usdc), 500e6);
        assertEq(pool.borrowed(borrower, address(usdc)), 500e6, "initial debt");
        usdc.mint(borrower, 500e6);
        pool.repay(address(usdc), 200e6);
        assertEq(pool.borrowed(borrower, address(usdc)), 300e6, "debt after repay");
        pool.withdraw(address(kub), 10 ether);
        assertEq(pool.supplied(borrower, address(kub)), 90 ether, "collateral after withdraw");
        vm.stopPrank();
    }

    function testInterestAccruesToBorrowersSuppliersAndReserves() public {
        vm.prank(borrower);
        pool.borrow(address(usdc), 500e6);
        uint256 lenderBefore = pool.supplied(lender, address(usdc));
        uint256 debtBefore = pool.borrowed(borrower, address(usdc));
        vm.warp(block.timestamp + 365 days);
        uint256 lenderAfter = pool.supplied(lender, address(usdc));
        uint256 debtAfter = pool.borrowed(borrower, address(usdc));
        (, , , uint256 pendingReserves) = pool.marketTotals(address(usdc));
        assertGt(debtAfter, debtBefore, "borrow interest missing");
        assertGt(lenderAfter, lenderBefore, "supplier interest missing");
        assertGt(pendingReserves, 0, "reserve interest missing");
        pool.accrue(address(usdc));
        (, , , uint256 storedReserves) = pool.marketTotals(address(usdc));
        assertGt(storedReserves, 0, "reserves not stored");
    }

    function testBorrowAboveLtvReverts() public {
        vm.startPrank(borrower);
        vm.expectRevert();
        pool.borrow(address(usdc), 800e6);
        vm.stopPrank();
    }

    function testLiquidationAfterCollateralPriceDrop() public {
        vm.prank(borrower);
        pool.borrow(address(usdc), 700e6);
        oracle.setPrice(address(kub), 8e18);
        uint256 hf = pool.healthFactor(borrower);
        assertLt(hf, 1e18, "account should be liquidatable");
        uint256 liquidatorKubBefore = kub.balanceOf(liquidator);
        vm.prank(liquidator);
        pool.liquidate(borrower, address(usdc), address(kub), 350e6);
        assertLt(pool.borrowed(borrower, address(usdc)), 700e6, "debt not reduced");
        assertGt(kub.balanceOf(liquidator), liquidatorKubBefore, "collateral not seized");
    }

    function testStaleOracleFailsClosed() public {
        vm.warp(block.timestamp + 31 minutes);
        vm.startPrank(borrower);
        vm.expectRevert();
        pool.borrow(address(usdc), 1e6);
        vm.stopPrank();
    }

    function testPauseBlocksNewSupplyAndBorrow() public {
        pool.setPaused(address(usdc), true);
        vm.startPrank(borrower);
        vm.expectRevert();
        pool.borrow(address(usdc), 1e6);
        vm.stopPrank();
        vm.startPrank(lender);
        vm.expectRevert();
        pool.supply(address(usdc), 1e6);
        vm.stopPrank();
    }

    function testSupplyAndBorrowCaps() public {
        pool.configureMarket(address(usdc), MaddethPool.MarketConfig({listed: true, paused: false, ltvBps: 8_000, liquidationThresholdBps: 8_500, liquidationBonusBps: 500, reserveFactorBps: 1_000, supplyCap: uint128(1_000_000e6), borrowCap: uint128(100e6), rateModel: address(rateModel)}));
        vm.startPrank(borrower);
        vm.expectRevert();
        pool.borrow(address(usdc), 101e6);
        vm.stopPrank();
    }
}
