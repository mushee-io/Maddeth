// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {LiquidationLabOracle} from "../contracts/LiquidationLabOracle.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

contract LiquidationLabTest is TestBase {
    uint256 internal constant WAD = 1e18;
    MaddethPool internal pool;
    InterestRateModel internal rateModel;
    LiquidationLabOracle internal oracle;
    MockERC20 internal labKUB;
    MockERC20 internal labUSDC;

    address internal lender = address(0xA11CE);
    address internal walletA = address(0xA0A0);
    address internal walletB = address(0xB0B0);

    function setUp() public {
        labKUB = new MockERC20("Maddeth Liquidation Lab KUB", "labKUB", 18);
        labUSDC = new MockERC20("Maddeth Liquidation Lab USDC", "labUSDC", 6);
        oracle = new LiquidationLabOracle(address(labKUB), address(labUSDC));
        rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        pool = new MaddethPool(address(oracle));

        pool.configureMarket(
            address(labKUB),
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
            address(labUSDC),
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

        labUSDC.mint(lender, 1_000_000e6);
        vm.startPrank(lender);
        labUSDC.approve(address(pool), type(uint256).max);
        pool.supply(address(labUSDC), 1_000_000e6);
        vm.stopPrank();

        labKUB.mint(walletA, 100 ether);
        vm.startPrank(walletA);
        labKUB.approve(address(pool), type(uint256).max);
        pool.supply(address(labKUB), 100 ether);
        pool.setCollateral(address(labKUB), true);
        pool.borrow(address(labUSDC), 700e6);
        vm.stopPrank();

        labUSDC.mint(walletB, 10_000e6);
        vm.prank(walletB);
        labUSDC.approve(address(pool), type(uint256).max);
    }

    function testNormalScenarioStartsHealthy() public {
        assertGt(pool.healthFactor(walletA), WAD, "Wallet A should start healthy at $10 labKUB");
    }

    function testBoundedShockMakesStandardScenarioLiquidatable() public {
        oracle.setShock(true);
        (uint256 price,) = oracle.getPrice(address(labKUB));
        assertEq(price, 8e18, "shock price must be fixed at $8");
        assertLt(pool.healthFactor(walletA), WAD, "Wallet A should be unhealthy after the bounded shock");

        oracle.setShock(false);
        (price,) = oracle.getPrice(address(labKUB));
        assertEq(price, 10e18, "reset price must be fixed at $10");
        assertGt(pool.healthFactor(walletA), WAD, "reset should restore the standard position to healthy");
    }

    function testWalletBCanExecuteFirstCloseFactorLiquidation() public {
        oracle.setShock(true);
        uint256 debtBefore = pool.borrowed(walletA, address(labUSDC));
        uint256 kubBefore = labKUB.balanceOf(walletB);

        vm.prank(walletB);
        pool.liquidate(walletA, address(labUSDC), address(labKUB), type(uint256).max);

        assertEq(debtBefore, 700e6, "unexpected initial debt");
        assertEq(pool.borrowed(walletA, address(labUSDC)), 350e6, "50% close factor not enforced");
        assertEq(labKUB.balanceOf(walletB) - kubBefore, 45_937_500_000_000_000_000, "unexpected first collateral seizure");
    }

    function testTwoLiquidationsRestoreHealth() public {
        oracle.setShock(true);
        assertLt(pool.healthFactor(walletA), WAD, "Wallet A should be liquidatable");

        vm.prank(walletB);
        pool.liquidate(walletA, address(labUSDC), address(labKUB), type(uint256).max);
        assertLt(pool.healthFactor(walletA), WAD, "first 50% close should leave standard scenario slightly unhealthy");

        vm.prank(walletB);
        pool.liquidate(walletA, address(labUSDC), address(labKUB), type(uint256).max);
        assertGt(pool.healthFactor(walletA), WAD, "second liquidation should restore health above 1");
        assertEq(pool.borrowed(walletA, address(labUSDC)), 175e6, "unexpected residual debt");
    }

    function testHealthyWalletCannotBeLiquidatedBeforeShock() public {
        vm.startPrank(walletB);
        vm.expectRevert(bytes("ACCOUNT_HEALTHY"));
        pool.liquidate(walletA, address(labUSDC), address(labKUB), 350e6);
        vm.stopPrank();
    }

    function testLabOracleRejectsCanonicalOrUnknownAssets() public {
        MockERC20 unknown = new MockERC20("Unknown", "UNK", 18);
        vm.expectRevert(bytes("UNSUPPORTED_ASSET"));
        oracle.getPrice(address(unknown));
    }
}
