// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockPriceOracle} from "../contracts/mocks/MockPriceOracle.sol";

/// @notice Phase 4 adversarial/stress coverage for the pooled lending core.
/// @dev All fault injection is isolated to Foundry mocks. No canonical KUB state is touched.
contract Phase4StressReadinessTest is TestBase {
    uint256 internal constant WAD = 1e18;

    MaddethPool internal pool;
    InterestRateModel internal rateModel;
    MockPriceOracle internal oracle;
    MockERC20 internal kub;
    MockERC20 internal usdc;

    address internal lender = address(0xA11CE);
    address internal riskAdmin = address(0xBEEF);
    address internal liquidatorA = address(0xCAFE);
    address internal liquidatorB = address(0xD00D);

    function setUp() public {
        oracle = new MockPriceOracle();
        rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        pool = new MaddethPool(address(oracle));
        kub = new MockERC20("Phase4 KUB", "p4KUB", 18);
        usdc = new MockERC20("Phase4 USDC", "p4USDC", 6);

        oracle.setPrice(address(kub), 10e18);
        oracle.setPrice(address(usdc), 1e18);

        pool.configureMarket(address(kub), _kubConfig());
        pool.configureMarket(address(usdc), _usdcConfig(100_000e6, 99_000e6));
        pool.setRiskAdmin(riskAdmin);

        usdc.mint(lender, 100_000e6);
        vm.startPrank(lender);
        usdc.approve(address(pool), type(uint256).max);
        pool.supply(address(usdc), 100_000e6);
        vm.stopPrank();

        usdc.mint(liquidatorA, 100_000e6);
        usdc.mint(liquidatorB, 100_000e6);
        vm.prank(liquidatorA);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(liquidatorB);
        usdc.approve(address(pool), type(uint256).max);
    }

    function testManyBorrowersCanDriveUtilisationNearOneWithoutBreakingAccounting() public {
        _openBorrowers(14, 7_000e6);

        (uint256 supplied, uint256 borrowed, uint256 utilisation,) = pool.marketTotals(address(usdc));
        uint256 cash = usdc.balanceOf(address(pool));

        assertEq(supplied, 100_000e6, "unexpected supplied total");
        assertEq(borrowed, 98_000e6, "unexpected borrowed total");
        assertGt(utilisation, 0.95e18, "utilisation did not reach stress band");
        assertLt(utilisation, WAD, "utilisation exceeded one");
        assertTrue(cash + borrowed >= supplied, "cash plus receivables do not cover suppliers");
    }

    function testBorrowCapStopsNextBorrowerBeforeOverextension() public {
        _openBorrowers(14, 7_000e6); // 98k of 99k cap
        address borrower = _prepareBorrower(99);

        vm.startPrank(borrower);
        vm.expectRevert(bytes("BORROW_CAP"));
        pool.borrow(address(usdc), 2_000e6);
        vm.stopPrank();

        (, uint256 borrowed,,) = pool.marketTotals(address(usdc));
        assertEq(borrowed, 98_000e6, "failed cap check changed total debt");
    }

    function testSupplyCapStopsAdditionalSupplier() public {
        address extraLender = address(0xEEEE);
        usdc.mint(extraLender, 1e6);
        vm.startPrank(extraLender);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(bytes("SUPPLY_CAP"));
        pool.supply(address(usdc), 1e6);
        vm.stopPrank();
    }

    function testLiquidityExhaustionFailsClosedEvenWhenBorrowCapIsUnlimited() public {
        _openBorrowers(14, 7_000e6); // leaves exactly 2,000 USDC cash
        pool.configureMarket(address(usdc), _usdcConfig(100_000e6, 0));
        address borrower = _prepareBorrower(101);

        vm.startPrank(borrower);
        vm.expectRevert(bytes("INSUFFICIENT_LIQUIDITY"));
        pool.borrow(address(usdc), 3_000e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(pool)), 2_000e6, "failed borrow moved pool cash");
    }

    function testTwoIndependentLiquidatorsCanSequentiallyRestoreHealth() public {
        address borrower = _prepareBorrower(1);
        vm.prank(borrower);
        pool.borrow(address(usdc), 7_000e6);

        oracle.setPrice(address(kub), 8e18);
        assertLt(pool.healthFactor(borrower), WAD, "borrower should be unhealthy");

        uint256 aBefore = kub.balanceOf(liquidatorA);
        vm.prank(liquidatorA);
        pool.liquidate(borrower, address(usdc), address(kub), type(uint256).max);
        assertGt(kub.balanceOf(liquidatorA), aBefore, "liquidator A received no collateral");
        assertLt(pool.healthFactor(borrower), WAD, "first close should leave residual risk");

        uint256 bBefore = kub.balanceOf(liquidatorB);
        vm.prank(liquidatorB);
        pool.liquidate(borrower, address(usdc), address(kub), type(uint256).max);
        assertGt(kub.balanceOf(liquidatorB), bBefore, "liquidator B received no collateral");
        assertGt(pool.healthFactor(borrower), WAD, "second close did not restore health");
        assertEq(pool.borrowed(borrower, address(usdc)), 1_750e6, "unexpected debt after two closes");
    }

    function testCollateralExhaustionThenBadDebtSocialisationPreservesAccounting() public {
        address borrower = _prepareBorrower(2);
        vm.prank(borrower);
        pool.borrow(address(usdc), 7_000e6);

        uint256 suppliedBefore;
        (suppliedBefore,,,) = pool.marketTotals(address(usdc));

        // A 90% collateral shock makes the position deeply insolvent.
        oracle.setPrice(address(kub), 1e18);
        vm.prank(liquidatorA);
        pool.liquidate(borrower, address(usdc), address(kub), type(uint256).max);

        assertEq(pool.supplied(borrower, address(kub)), 0, "collateral was not exhausted");
        uint256 residualDebt = pool.borrowed(borrower, address(usdc));
        assertGt(residualDebt, 0, "expected residual bad debt");

        pool.absorbBadDebt(borrower, address(usdc));
        assertEq(pool.borrowed(borrower, address(usdc)), 0, "bad debt was not written off");

        (uint256 suppliedAfter, uint256 borrowedAfter,,) = pool.marketTotals(address(usdc));
        uint256 cash = usdc.balanceOf(address(pool));
        assertLt(suppliedAfter, suppliedBefore, "supplier loss was not socialised");
        assertEq(borrowedAfter, 0, "borrow receivable remained after absorption");
        assertTrue(cash + borrowedAfter >= suppliedAfter, "post-loss accounting deficit");
    }

    function testProtocolPauseDuringActiveDebtBlocksRiskIncreaseButAllowsRepair() public {
        address borrower = _prepareBorrower(3);
        vm.prank(borrower);
        pool.borrow(address(usdc), 4_000e6);

        vm.prank(riskAdmin);
        pool.setProtocolPaused(true);
        assertTrue(pool.protocolPaused(), "risk admin failed to pause");

        vm.startPrank(borrower);
        vm.expectRevert(bytes("MARKET_UNAVAILABLE"));
        pool.borrow(address(usdc), 1e6);
        vm.stopPrank();

        usdc.mint(borrower, 1_000e6);
        vm.startPrank(borrower);
        usdc.approve(address(pool), type(uint256).max);
        pool.repay(address(usdc), 1_000e6);
        vm.stopPrank();
        assertLt(pool.borrowed(borrower, address(usdc)), 4_000e6, "repay blocked during pause");

        uint256 lenderBefore = usdc.balanceOf(lender);
        vm.prank(lender);
        pool.withdraw(address(usdc), 100e6);
        assertEq(usdc.balanceOf(lender), lenderBefore + 100e6, "safe withdrawal blocked during pause");

        vm.startPrank(riskAdmin);
        vm.expectRevert(bytes("OWNER_REQUIRED_TO_UNPAUSE"));
        pool.setProtocolPaused(false);
        vm.stopPrank();

        pool.setProtocolPaused(false);
        assertTrue(!pool.protocolPaused(), "owner could not recover protocol");
    }

    function testReserveWithdrawalCannotExceedAccruedReserves() public {
        address borrower = _prepareBorrower(4);
        vm.prank(borrower);
        pool.borrow(address(usdc), 5_000e6);
        vm.warp(block.timestamp + 180 days);
        pool.accrue(address(usdc));

        (,,, uint256 reserves) = pool.marketTotals(address(usdc));
        assertGt(reserves, 0, "stress setup accrued no reserves");

        vm.expectRevert(bytes("RESERVE_BALANCE"));
        pool.withdrawReserves(address(usdc), address(this), reserves + 1);

        uint256 ownerBefore = usdc.balanceOf(address(this));
        pool.withdrawReserves(address(usdc), address(this), reserves / 2);
        assertGt(usdc.balanceOf(address(this)), ownerBefore, "valid reserve withdrawal failed");
    }

    function testFuzzBorrowWithinHeadroomNeverCreatesImmediateLiquidation(uint96 rawAmount) public {
        address borrower = _prepareBorrower(77);
        uint256 amount = 1e6 + (uint256(rawAmount) % 7_000e6);
        vm.prank(borrower);
        pool.borrow(address(usdc), amount);
        assertTrue(pool.healthFactor(borrower) >= WAD, "borrow created immediately liquidatable account");
    }

    function _openBorrowers(uint256 count, uint256 amountEach) internal {
        for (uint256 i = 0; i < count; i++) {
            address borrower = _prepareBorrower(i + 10);
            vm.prank(borrower);
            pool.borrow(address(usdc), amountEach);
        }
    }

    function _prepareBorrower(uint256 salt) internal returns (address borrower) {
        borrower = address(uint160(0x1000 + salt));
        kub.mint(borrower, 1_000 ether);
        vm.startPrank(borrower);
        kub.approve(address(pool), type(uint256).max);
        pool.supply(address(kub), 1_000 ether);
        pool.setCollateral(address(kub), true);
        vm.stopPrank();
    }

    function _kubConfig() internal view returns (MaddethPool.MarketConfig memory) {
        return MaddethPool.MarketConfig({
            listed: true,
            paused: false,
            ltvBps: 7_500,
            liquidationThresholdBps: 8_000,
            liquidationBonusBps: 500,
            reserveFactorBps: 1_000,
            supplyCap: uint128(100_000_000 ether),
            borrowCap: uint128(50_000_000 ether),
            rateModel: address(rateModel)
        });
    }

    function _usdcConfig(uint128 supplyCap, uint128 borrowCap) internal view returns (MaddethPool.MarketConfig memory) {
        return MaddethPool.MarketConfig({
            listed: true,
            paused: false,
            ltvBps: 8_000,
            liquidationThresholdBps: 8_500,
            liquidationBonusBps: 500,
            reserveFactorBps: 1_000,
            supplyCap: supplyCap,
            borrowCap: borrowCap,
            rateModel: address(rateModel)
        });
    }
}
