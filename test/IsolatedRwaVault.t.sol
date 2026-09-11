// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {IsolatedRwaVault} from "../contracts/IsolatedRwaVault.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

contract IsolatedRwaVaultTest is TestBase {
    MockERC20 internal usdc;
    IsolatedRwaVault internal vault;

    address internal lender = address(0xA11CE);
    address internal borrower = address(0xB0B);

    function setUp() public {
        usdc = new MockERC20("Mock USD Coin", "mUSDC", 6);
        vault = new IsolatedRwaVault(address(usdc), address(this), borrower, block.timestamp + 30 days, 500_000e6);
        vault.setLender(lender, true);

        usdc.mint(lender, 1_000_000e6);
        vm.prank(lender);
        usdc.approve(address(vault), type(uint256).max);

        usdc.mint(borrower, 1_000_000e6);
        vm.prank(borrower);
        usdc.approve(address(vault), type(uint256).max);
    }

    function testAllowlistedLenderDepositAndBorrowerDraw() public {
        vm.prank(lender);
        vault.deposit(400_000e6);
        assertEq(vault.totalDeposits(), 400_000e6, "deposit total");

        vm.prank(borrower);
        vault.borrow(200_000e6);
        assertEq(vault.totalDebt(), 200_000e6, "debt total");
        assertEq(vault.principalOutstanding(), 200_000e6, "principal total");
    }

    function testDebtCapEnforced() public {
        vm.prank(lender);
        vault.deposit(600_000e6);

        vm.startPrank(borrower);
        vm.expectRevert(bytes("DEBT_CAP"));
        vault.borrow(500_001e6);
        vm.stopPrank();
    }

    function testWithdrawBlockedWhileCreditOutstanding() public {
        vm.prank(lender);
        vault.deposit(300_000e6);
        vm.prank(borrower);
        vault.borrow(100_000e6);

        vm.startPrank(lender);
        vm.expectRevert(bytes("CREDIT_OUTSTANDING"));
        vault.withdraw(10_000e6);
        vm.stopPrank();
    }

    function testRepayUnlocksWithdrawal() public {
        vm.prank(lender);
        vault.deposit(300_000e6);
        vm.prank(borrower);
        vault.borrow(100_000e6);

        vm.prank(borrower);
        vault.repay(100_000e6);

        uint256 before = usdc.balanceOf(lender);
        vm.prank(lender);
        vault.withdraw(50_000e6);
        assertEq(usdc.balanceOf(lender), before + 50_000e6, "withdrawal not received");
    }

    function testBorrowBlockedAfterMaturity() public {
        vm.prank(lender);
        vault.deposit(300_000e6);
        vm.warp(block.timestamp + 31 days);

        vm.startPrank(borrower);
        vm.expectRevert(bytes("VAULT_CLOSED"));
        vault.borrow(1e6);
        vm.stopPrank();
    }

    function testDefaultCanOnlyBeDeclaredAfterMaturityWithDebt() public {
        vm.prank(lender);
        vault.deposit(300_000e6);
        vm.prank(borrower);
        vault.borrow(100_000e6);

        vm.expectRevert(bytes("NOT_MATURED"));
        vault.declareDefault();

        vm.warp(block.timestamp + 31 days);
        vault.declareDefault();
        assertTrue(vault.defaulted(), "default flag missing");
        assertTrue(vault.paused(), "default should pause vault");
    }

    function testDefaultCuresAfterFullRecovery() public {
        vm.prank(lender);
        vault.deposit(300_000e6);
        vm.prank(borrower);
        vault.borrow(100_000e6);
        vm.warp(block.timestamp + 31 days);
        vault.declareDefault();

        vm.prank(borrower);
        vault.repay(100_000e6);
        assertTrue(!vault.defaulted(), "default not cured");
        assertEq(vault.totalDebt(), 0, "debt remains");
    }

    function testFixedAprAccruesToLenderShareValue() public {
        vault.setFixedAprBps(1_200); // 12% annual fixed testnet term
        vm.prank(lender);
        vault.deposit(300_000e6);
        vm.prank(borrower);
        vault.borrow(120_000e6);

        vm.warp(block.timestamp + 15 days);
        uint256 debtWithInterest = vault.totalDebt();
        assertGt(debtWithInterest, 120_000e6, "interest did not accrue");
        assertGt(vault.deposits(lender), 300_000e6, "lender NAV did not increase");

        vm.prank(borrower);
        vault.repay(debtWithInterest);
        assertEq(vault.totalDebt(), 0, "debt not fully repaid");
        assertEq(vault.principalOutstanding(), 0, "principal not cleared");

        uint256 claim = vault.deposits(lender);
        assertGt(claim, 300_000e6, "yield not claimable");
        uint256 before = usdc.balanceOf(lender);
        vm.prank(lender);
        vault.withdraw(claim);
        assertGt(usdc.balanceOf(lender), before + 300_000e6, "yield not paid to lender");
    }

    function testAprTermsLockAfterFunding() public {
        vault.setFixedAprBps(900);
        vm.prank(lender);
        vault.deposit(1_000e6);
        vm.expectRevert(bytes("TERMS_LOCKED"));
        vault.setFixedAprBps(1_000);
    }
}
