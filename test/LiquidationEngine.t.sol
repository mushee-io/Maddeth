// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockPriceOracle} from "../contracts/mocks/MockPriceOracle.sol";

/// @notice Phase 2 liquidation tests use two independent user wallets and a mutable TEST-ONLY oracle.
/// @dev This suite deliberately forces insolvency conditions without changing the canonical KUB oracle path.
contract LiquidationEngineTest is TestBase {
    uint256 internal constant WAD = 1e18;

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
        kub = new MockERC20("Liquidation Lab KUB", "labKUB", 18);
        usdc = new MockERC20("Liquidation Lab USDC", "labUSDC", 6);

        oracle.setPrice(address(kub), 10e18);
        oracle.setPrice(address(usdc), 1e18);

        pool.configureMarket(
            address(kub),
            MaddethPool.MarketConfig({
                listed: true,
                paused: false,
                ltvBps: 7_500,
                liquidationThresholdBps: 8_000,
                liquidationBonusBps: 500,
                reserveFactorBps: 1_000,
                supplyCap: uint128(10_000_000 ether),
                borrowCap: uint128(5_000_000 ether),
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
                liquidationBonusBps: 500,
                reserveFactorBps: 1_000,
                supplyCap: uint128(10_000_000e6),
                borrowCap: uint128(5_000_000e6),
                rateModel: address(rateModel)
            })
        );

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

    function testHealthyAccountCannotBeLiquidated() public {
        assertGt(pool.healthFactor(borrower), WAD, "setup should start healthy");

        vm.startPrank(liquidator);
        vm.expectRevert(bytes("ACCOUNT_HEALTHY"));
        pool.liquidate(borrower, address(usdc), address(kub), 350e6);
        vm.stopPrank();
    }

    function testPriceDropMakesBorrowerLiquidatable() public {
        oracle.setPrice(address(kub), 8e18);
        assertLt(pool.healthFactor(borrower), WAD, "price shock did not make account unhealthy");
    }

    function testCloseFactorCapsRepayAndAppliesLiquidationBonus() public {
        oracle.setPrice(address(kub), 8e18);
        uint256 healthBefore = pool.healthFactor(borrower);
        uint256 liquidatorKubBefore = kub.balanceOf(liquidator);

        // Request the entire debt. The pool must cap one liquidation to the 50% close factor.
        vm.prank(liquidator);
        pool.liquidate(borrower, address(usdc), address(kub), 700e6);

        uint256 debtAfter = pool.borrowed(borrower, address(usdc));
        uint256 seized = kub.balanceOf(liquidator) - liquidatorKubBefore;
        uint256 healthAfter = pool.healthFactor(borrower);

        assertEq(debtAfter, 350e6, "close factor did not cap repayment at 50%");
        assertEq(seized, 45_937_500_000_000_000_000, "unexpected collateral seizure or bonus");
        assertGt(healthAfter, healthBefore, "liquidation did not improve borrower health");
    }

    function testTwoWalletRepeatedLiquidationCanRestoreHealth() public {
        oracle.setPrice(address(kub), 8e18);
        assertLt(pool.healthFactor(borrower), WAD, "borrower should be liquidatable");

        vm.prank(liquidator);
        pool.liquidate(borrower, address(usdc), address(kub), type(uint256).max);
        assertLt(pool.healthFactor(borrower), WAD, "first close-factor liquidation should leave residual risk");

        vm.prank(liquidator);
        pool.liquidate(borrower, address(usdc), address(kub), type(uint256).max);

        assertGt(pool.healthFactor(borrower), WAD, "second liquidation did not restore account health");
        assertEq(pool.borrowed(borrower, address(usdc)), 175e6, "unexpected residual debt after two close-factor liquidations");
        assertGt(kub.balanceOf(liquidator), 0, "liquidator received no collateral");
    }

    function testCollateralLimitedLiquidationDoesNotOverchargeLiquidator() public {
        oracle.setPrice(address(kub), 1e18);
        uint256 usdcBefore = usdc.balanceOf(liquidator);
        uint256 kubBefore = kub.balanceOf(liquidator);

        vm.prank(liquidator);
        pool.liquidate(borrower, address(usdc), address(kub), 350e6);

        uint256 spent = usdcBefore - usdc.balanceOf(liquidator);
        uint256 seized = kub.balanceOf(liquidator) - kubBefore;

        assertLt(spent, 100e6, "liquidator paid more than exhausted collateral supports");
        assertGt(spent, 95e6, "collateral repayment cap unexpectedly low");
        assertEq(seized, 100 ether, "collateral-limited path did not seize all available collateral");
        assertEq(pool.supplied(borrower, address(kub)), 0, "borrower collateral should be exhausted");
    }

    function testLiquidatorNeedsDebtAssetApprovalAndBalance() public {
        oracle.setPrice(address(kub), 8e18);
        address emptyLiquidator = address(0xDEAD);

        vm.startPrank(emptyLiquidator);
        vm.expectRevert();
        pool.liquidate(borrower, address(usdc), address(kub), 100e6);
        vm.stopPrank();

        assertEq(pool.borrowed(borrower, address(usdc)), 700e6, "failed liquidation changed debt");
    }
}
