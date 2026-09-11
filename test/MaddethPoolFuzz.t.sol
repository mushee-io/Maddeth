// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockPriceOracle} from "../contracts/mocks/MockPriceOracle.sol";

contract MaddethPoolFuzzTest is TestBase {
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
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        oracle.setPrice(address(kub), 10e18);
        oracle.setPrice(address(usdc), 1e18);

        pool.configureMarket(address(kub), MaddethPool.MarketConfig({listed: true, paused: false, ltvBps: 7_500, liquidationThresholdBps: 8_000, liquidationBonusBps: 500, reserveFactorBps: 1_000, supplyCap: uint128(10_000_000 ether), borrowCap: uint128(5_000_000 ether), rateModel: address(rateModel)}));
        pool.configureMarket(address(usdc), MaddethPool.MarketConfig({listed: true, paused: false, ltvBps: 8_000, liquidationThresholdBps: 8_500, liquidationBonusBps: 500, reserveFactorBps: 1_000, supplyCap: uint128(10_000_000e6), borrowCap: uint128(5_000_000e6), rateModel: address(rateModel)}));

        usdc.mint(lender, 1_000_000e6);
        kub.mint(borrower, 100 ether);
        usdc.mint(liquidator, 1_000_000e6);

        vm.startPrank(lender);
        usdc.approve(address(pool), type(uint256).max);
        pool.supply(address(usdc), 1_000_000e6);
        vm.stopPrank();

        vm.startPrank(borrower);
        kub.approve(address(pool), type(uint256).max);
        pool.supply(address(kub), 100 ether);
        pool.setCollateral(address(kub), true);
        vm.stopPrank();

        vm.prank(liquidator);
        usdc.approve(address(pool), type(uint256).max);
    }

    function testFuzzBorrowWithinLtv(uint96 rawAmount) public {
        uint256 amount = 1 + (uint256(rawAmount) % 750e6);
        vm.prank(borrower);
        pool.borrow(address(usdc), amount);
        assertTrue(pool.borrowed(borrower, address(usdc)) >= amount, "borrow accounting below principal");
    }

    function testFuzzPartialRepaymentNeverIncreasesDebt(uint96 rawRepay) public {
        vm.prank(borrower);
        pool.borrow(address(usdc), 500e6);
        uint256 beforeDebt = pool.borrowed(borrower, address(usdc));
        uint256 repayAmount = 1 + (uint256(rawRepay) % 500e6);

        vm.prank(liquidator);
        pool.repayFor(borrower, address(usdc), repayAmount);
        uint256 afterDebt = pool.borrowed(borrower, address(usdc));
        assertTrue(afterDebt < beforeDebt, "repayment did not reduce debt");
    }

    function testFuzzDeepPriceDropLiquidationReducesDebt(uint64 rawPrice) public {
        vm.prank(borrower);
        pool.borrow(address(usdc), 700e6);

        uint256 price = 1e18 + (uint256(rawPrice) % 7_700_000_000_000_000_000);
        oracle.setPrice(address(kub), price);
        uint256 beforeDebt = pool.borrowed(borrower, address(usdc));

        vm.prank(liquidator);
        pool.liquidate(borrower, address(usdc), address(kub), 350e6);
        assertTrue(pool.borrowed(borrower, address(usdc)) < beforeDebt, "liquidation did not reduce debt");
    }
}
