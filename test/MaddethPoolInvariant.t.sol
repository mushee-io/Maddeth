// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockPriceOracle} from "../contracts/mocks/MockPriceOracle.sol";

contract MaddethHandler is TestBase {
    MaddethPool public pool;
    MockERC20 public kub;
    MockERC20 public usdc;
    address public borrower;
    address public lender;

    constructor(MaddethPool _pool, MockERC20 _kub, MockERC20 _usdc, address _borrower, address _lender) {
        pool = _pool;
        kub = _kub;
        usdc = _usdc;
        borrower = _borrower;
        lender = _lender;
    }

    function supplyUsdc(uint96 rawAmount) external {
        uint256 amount = 1e6 + (uint256(rawAmount) % 1_000e6);
        usdc.mint(lender, amount);
        vm.prank(lender);
        pool.supply(address(usdc), amount);
    }

    function addKubCollateral(uint96 rawAmount) external {
        uint256 amount = 1e15 + (uint256(rawAmount) % 5 ether);
        kub.mint(borrower, amount);
        vm.prank(borrower);
        pool.supply(address(kub), amount);
    }

    function borrowUsdc(uint96 rawAmount) external {
        (, uint256 borrowLimitUsd,, uint256 debtUsd) = pool.getAccountLiquidity(borrower);
        if (borrowLimitUsd <= debtUsd) return;
        uint256 headroomToken = (borrowLimitUsd - debtUsd) / 1e12;
        if (headroomToken == 0) return;
        uint256 amount = 1 + (uint256(rawAmount) % headroomToken);
        vm.prank(borrower);
        pool.borrow(address(usdc), amount);
    }

    function repayUsdc(uint96 rawAmount) external {
        uint256 debt = pool.borrowed(borrower, address(usdc));
        if (debt == 0) return;
        uint256 amount = 1 + (uint256(rawAmount) % debt);
        usdc.mint(borrower, amount);
        vm.prank(borrower);
        pool.repay(address(usdc), amount);
    }
}

contract MaddethPoolInvariantTest is TestBase {
    MaddethPool internal pool;
    InterestRateModel internal rateModel;
    MockPriceOracle internal oracle;
    MockERC20 internal kub;
    MockERC20 internal usdc;
    MaddethHandler internal handler;

    address internal lender = address(0xA11CE);
    address internal borrower = address(0xB0B);
    address[] private _targets;

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

        handler = new MaddethHandler(pool, kub, usdc, borrower, lender);
        _targets.push(address(handler));
    }

    /// @dev Foundry invariant target discovery compatible with forge-std StdInvariant.
    function targetContracts() external view returns (address[] memory) {
        return _targets;
    }

    function invariantCashPlusReceivablesCoverSuppliers() public view {
        (uint256 suppliedUsdc, uint256 borrowedUsdc,,) = pool.marketTotals(address(usdc));
        uint256 cash = usdc.balanceOf(address(pool));
        assertTrue(cash + borrowedUsdc >= suppliedUsdc, "USDC accounting deficit");
    }

    function invariantBorrowerRemainsAboveLiquidationThreshold() public view {
        uint256 hf = pool.healthFactor(borrower);
        assertTrue(hf >= 1e18, "handler created unhealthy borrower");
    }

    function invariantIndexesNeverReachZero() public view {
        (uint256 kubSupplyIndex, uint256 kubBorrowIndex) = pool.currentIndexes(address(kub));
        (uint256 usdcSupplyIndex, uint256 usdcBorrowIndex) = pool.currentIndexes(address(usdc));
        assertTrue(kubSupplyIndex > 0 && kubBorrowIndex > 0, "KUB index zero");
        assertTrue(usdcSupplyIndex > 0 && usdcBorrowIndex > 0, "USDC index zero");
    }
}
