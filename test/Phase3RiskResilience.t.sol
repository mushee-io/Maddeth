// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {FaultyPriceOracle} from "../contracts/mocks/FaultyPriceOracle.sol";

/// @notice Phase 3 exercises explicit bad-debt handling, oracle failure modes and emergency-role boundaries.
/// @dev All fault injection is local/test-only. The canonical KUB oracle is never modified by this suite.
contract Phase3RiskResilienceTest is TestBase {
    uint256 internal constant WAD = 1e18;

    MaddethPool internal pool;
    InterestRateModel internal rateModel;
    FaultyPriceOracle internal oracle;
    MockERC20 internal kub;
    MockERC20 internal usdc;

    address internal lender = address(0xA11CE);
    address internal borrower = address(0xB0B);
    address internal liquidator = address(0xCAFE);
    address internal riskAdmin = address(0xBEEF);

    function setUp() public {
        vm.warp(10 days);
        oracle = new FaultyPriceOracle();
        rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        pool = new MaddethPool(address(oracle));
        kub = new MockERC20("Phase 3 KUB", "p3KUB", 18);
        usdc = new MockERC20("Phase 3 USDC", "p3USDC", 6);

        oracle.setNow(address(kub), 10e18);
        oracle.setNow(address(usdc), 1e18);

        pool.configureMarket(address(kub), _kubConfig());
        pool.configureMarket(address(usdc), _usdcConfig());
        pool.setRiskAdmin(riskAdmin);

        usdc.mint(lender, 1_000_000e6);
        kub.mint(borrower, 100 ether);
        usdc.mint(liquidator, 100_000e6);

        vm.startPrank(lender);
        usdc.approve(address(pool), type(uint256).max);
        pool.supply(address(usdc), 1_000_000e6);
        vm.stopPrank();

        vm.startPrank(borrower);
        kub.approve(address(pool), type(uint256).max);
        pool.supply(address(kub), 100 ether);
        pool.setCollateral(address(kub), true);
        pool.borrow(address(usdc), 700e6);
        vm.stopPrank();

        vm.prank(liquidator);
        usdc.approve(address(pool), type(uint256).max);
    }

    function testBadDebtCannotBeAbsorbedWhileCollateralRemains() public {
        oracle.setNow(address(kub), 1e18);
        oracle.setNow(address(usdc), 1e18);
        assertLt(pool.healthFactor(borrower), WAD, "borrower should be unhealthy");

        vm.expectRevert(bytes("COLLATERAL_REMAINS"));
        pool.absorbBadDebt(borrower, address(usdc));
    }

    function testOnlyOwnerCanAbsorbBadDebt() public {
        _exhaustCollateral();
        assertEq(pool.supplied(borrower, address(kub)), 0, "collateral not exhausted");

        vm.startPrank(riskAdmin);
        vm.expectRevert(bytes("NOT_OWNER"));
        pool.absorbBadDebt(borrower, address(usdc));
        vm.stopPrank();
    }

    function testBadDebtAbsorptionClearsDebtAndSocializesResidualLoss() public {
        _exhaustCollateral();
        uint256 debtBefore = pool.borrowed(borrower, address(usdc));
        uint256 lenderSupplyBefore = pool.supplied(lender, address(usdc));
        (, uint256 totalBorrowBefore,,) = pool.marketTotals(address(usdc));

        assertGt(debtBefore, 0, "expected residual debt");
        pool.absorbBadDebt(borrower, address(usdc));

        uint256 lenderSupplyAfter = pool.supplied(lender, address(usdc));
        (, uint256 totalBorrowAfter,,) = pool.marketTotals(address(usdc));

        assertEq(pool.borrowed(borrower, address(usdc)), 0, "bad debt not cleared");
        assertLt(lenderSupplyAfter, lenderSupplyBefore, "supplier loss was hidden");
        assertLt(totalBorrowAfter, totalBorrowBefore, "market borrow accounting not reduced");
    }

    function testAccruedReservesCoverBadDebtBeforeSupplierLoss() public {
        vm.warp(block.timestamp + 365 days);
        pool.accrue(address(usdc));
        (,,, uint256 reservesBefore) = pool.marketTotals(address(usdc));
        assertGt(reservesBefore, 0, "setup did not accrue reserves");

        _exhaustCollateral();
        uint256 lenderSupplyBefore = pool.supplied(lender, address(usdc));
        pool.absorbBadDebt(borrower, address(usdc));
        uint256 lenderSupplyAfter = pool.supplied(lender, address(usdc));
        (,,, uint256 reservesAfter) = pool.marketTotals(address(usdc));

        assertLt(reservesAfter, reservesBefore, "reserves were not consumed first");
        assertLt(lenderSupplyAfter, lenderSupplyBefore, "residual loss did not reach supplier index");
    }

    function testZeroPriceFailsClosedOnBorrow() public {
        oracle.setNow(address(kub), 10e18);
        oracle.setNow(address(usdc), 0);

        vm.startPrank(borrower);
        vm.expectRevert(bytes("INVALID_PRICE"));
        pool.borrow(address(usdc), 1e6);
        vm.stopPrank();
    }

    function testStalePriceFailsClosedOnBorrow() public {
        oracle.setNow(address(usdc), 1e18);
        oracle.setPrice(address(kub), 10e18, block.timestamp - pool.MAX_ORACLE_AGE() - 1);

        vm.startPrank(borrower);
        vm.expectRevert(bytes("STALE_PRICE"));
        pool.borrow(address(usdc), 1e6);
        vm.stopPrank();
    }

    function testFuturePriceFailsClosedOnBorrow() public {
        oracle.setNow(address(usdc), 1e18);
        oracle.setPrice(address(kub), 10e18, block.timestamp + 1);

        vm.startPrank(borrower);
        vm.expectRevert(bytes("FUTURE_PRICE"));
        pool.borrow(address(usdc), 1e6);
        vm.stopPrank();
    }

    function testOracleRecoveryRestoresBorrowPath() public {
        oracle.setNow(address(usdc), 1e18);
        oracle.setPrice(address(kub), 10e18, block.timestamp - pool.MAX_ORACLE_AGE() - 1);

        vm.startPrank(borrower);
        vm.expectRevert(bytes("STALE_PRICE"));
        pool.borrow(address(usdc), 1e6);
        vm.stopPrank();

        oracle.setNow(address(kub), 10e18);
        oracle.setNow(address(usdc), 1e18);
        vm.prank(borrower);
        pool.borrow(address(usdc), 1e6);
        assertGt(pool.borrowed(borrower, address(usdc)), 700e6, "borrow path did not recover");
    }

    function testStalePriceBlocksLiquidationWithoutChangingDebt() public {
        oracle.setNow(address(usdc), 1e18);
        oracle.setPrice(address(kub), 8e18, block.timestamp - pool.MAX_ORACLE_AGE() - 1);
        uint256 debtBefore = pool.borrowed(borrower, address(usdc));

        vm.startPrank(liquidator);
        vm.expectRevert(bytes("STALE_PRICE"));
        pool.liquidate(borrower, address(usdc), address(kub), type(uint256).max);
        vm.stopPrank();

        assertEq(pool.borrowed(borrower, address(usdc)), debtBefore, "failed liquidation changed debt");
    }

    function testRiskAdminCannotReconfigureMarketRisk() public {
        vm.startPrank(riskAdmin);
        vm.expectRevert(bytes("NOT_OWNER"));
        pool.configureMarket(address(kub), _kubConfig());
        vm.stopPrank();
    }

    function testRiskAdminPauseOwnerOnlyRecoveryBoundary() public {
        vm.prank(riskAdmin);
        pool.setProtocolPaused(true);
        assertTrue(pool.protocolPaused(), "risk admin could not pause");

        vm.startPrank(riskAdmin);
        vm.expectRevert(bytes("OWNER_REQUIRED_TO_UNPAUSE"));
        pool.setProtocolPaused(false);
        vm.stopPrank();

        pool.setProtocolPaused(false);
        assertTrue(!pool.protocolPaused(), "owner could not recover protocol");
    }

    function _exhaustCollateral() internal {
        oracle.setNow(address(kub), 1e18);
        oracle.setNow(address(usdc), 1e18);
        vm.prank(liquidator);
        pool.liquidate(borrower, address(usdc), address(kub), type(uint256).max);
        assertEq(pool.supplied(borrower, address(kub)), 0, "liquidation did not exhaust collateral");
        assertGt(pool.borrowed(borrower, address(usdc)), 0, "expected residual debt");
    }

    function _kubConfig() internal view returns (MaddethPool.MarketConfig memory) {
        return MaddethPool.MarketConfig({
            listed: true,
            paused: false,
            ltvBps: 7_500,
            liquidationThresholdBps: 8_000,
            liquidationBonusBps: 500,
            reserveFactorBps: 1_000,
            supplyCap: uint128(10_000_000 ether),
            borrowCap: uint128(5_000_000 ether),
            rateModel: address(rateModel)
        });
    }

    function _usdcConfig() internal view returns (MaddethPool.MarketConfig memory) {
        return MaddethPool.MarketConfig({
            listed: true,
            paused: false,
            ltvBps: 8_000,
            liquidationThresholdBps: 8_500,
            liquidationBonusBps: 500,
            reserveFactorBps: 1_000,
            supplyCap: uint128(10_000_000e6),
            borrowCap: uint128(5_000_000e6),
            rateModel: address(rateModel)
        });
    }
}
