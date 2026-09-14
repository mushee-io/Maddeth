// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {IsolatedRwaVault} from "../contracts/IsolatedRwaVault.sol";
import {RwaVaultFactory} from "../contracts/RwaVaultFactory.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

contract RwaHardeningTest is TestBase {
    MockERC20 internal usdc;
    IsolatedRwaVault internal vault;
    RwaVaultFactory internal factory;

    address internal lenderA = address(0xA11CE);
    address internal lenderB = address(0xB0B);
    address internal borrower = address(0xB0B0);
    address internal issuer = address(0x155E);
    address internal newOwner = address(0xCAFE);

    function setUp() public {
        usdc = new MockERC20("RWA Test USDC", "rUSDC", 6);
        vault = new IsolatedRwaVault(address(usdc), address(this), borrower, block.timestamp + 30 days, 500_000e6);
        vault.setFixedAprBps(1_200);
        vault.setLender(lenderA, true);
        vault.setLender(lenderB, true);

        usdc.mint(lenderA, 1_000_000e6);
        usdc.mint(lenderB, 1_000_000e6);
        usdc.mint(borrower, 1_000_000e6);
        vm.prank(lenderA); usdc.approve(address(vault), type(uint256).max);
        vm.prank(lenderB); usdc.approve(address(vault), type(uint256).max);
        vm.prank(borrower); usdc.approve(address(vault), type(uint256).max);

        factory = new RwaVaultFactory();
        factory.setIssuer(issuer, true);
    }

    function testRevokedLenderCannotAddCapitalButKeepsExistingClaim() public {
        vm.prank(lenderA);
        vault.deposit(100_000e6);
        uint256 claimBefore = vault.deposits(lenderA);

        vault.setLender(lenderA, false);
        vm.startPrank(lenderA);
        vm.expectRevert(bytes("NOT_ALLOWED"));
        vault.deposit(1e6);
        vm.stopPrank();

        assertEq(vault.deposits(lenderA), claimBefore, "revocation changed existing lender claim");
        vm.prank(lenderA);
        vault.withdraw(10_000e6);
    }

    function testPauseBlocksNewFundingAndBorrowingButNotRepaymentOrSafeExit() public {
        vm.prank(lenderA);
        vault.deposit(200_000e6);
        vm.prank(borrower);
        vault.borrow(50_000e6);

        vault.setPaused(true);

        vm.startPrank(lenderB);
        vm.expectRevert(bytes("NOT_ALLOWED"));
        vault.deposit(1_000e6);
        vm.stopPrank();

        vm.startPrank(borrower);
        vm.expectRevert(bytes("VAULT_CLOSED"));
        vault.borrow(1e6);
        vm.stopPrank();

        uint256 debt = vault.totalDebt();
        vm.prank(borrower);
        vault.repay(debt);
        assertEq(vault.totalDebt(), 0, "repayment blocked during pause");

        uint256 before = usdc.balanceOf(lenderA);
        vm.prank(lenderA);
        vault.withdraw(20_000e6);
        assertEq(usdc.balanceOf(lenderA), before + 20_000e6, "safe exit blocked during pause");
    }

    function testMaturityStopsNewCapitalAndNewBorrowButAllowsRepaymentAndExit() public {
        vm.prank(lenderA);
        vault.deposit(250_000e6);
        vm.prank(borrower);
        vault.borrow(100_000e6);

        vm.warp(block.timestamp + 31 days);

        vm.startPrank(lenderB);
        vm.expectRevert(bytes("VAULT_CLOSED"));
        vault.deposit(1_000e6);
        vm.stopPrank();

        vm.startPrank(borrower);
        vm.expectRevert(bytes("VAULT_CLOSED"));
        vault.borrow(1e6);
        vm.stopPrank();

        uint256 debt = vault.totalDebt();
        vm.prank(borrower);
        vault.repay(debt);
        assertEq(vault.totalDebt(), 0, "matured vault did not accept repayment");

        uint256 claim = vault.deposits(lenderA);
        vm.prank(lenderA);
        vault.withdraw(claim);
        assertEq(vault.lenderShares(lenderA), 0, "matured lender could not redeem after repayment");
    }

    function testDefaultLifecycleRequiresMaturityAndOwnerRecoveryAfterCure() public {
        vm.prank(lenderA);
        vault.deposit(300_000e6);
        vm.prank(borrower);
        vault.borrow(120_000e6);

        vm.expectRevert(bytes("NOT_MATURED"));
        vault.declareDefault();

        vm.warp(block.timestamp + 31 days);
        vault.declareDefault();
        assertTrue(vault.defaulted(), "default not declared");
        assertTrue(vault.paused(), "default did not pause vault");

        uint256 debt = vault.totalDebt();
        vm.prank(borrower);
        vault.repay(debt);
        assertTrue(!vault.defaulted(), "full recovery did not cure default");
        assertTrue(vault.paused(), "cure should not silently reopen vault");

        vault.setPaused(false);
        assertTrue(!vault.paused(), "owner could not explicitly recover vault");
    }

    function testDebtCapAppliesToPrincipalEvenAfterInterestAccrual() public {
        vm.prank(lenderA);
        vault.deposit(500_000e6);
        vm.prank(borrower);
        vault.borrow(490_000e6);
        vm.warp(block.timestamp + 20 days);
        vault.accrue();

        assertGt(vault.totalDebt(), 490_000e6, "interest did not accrue");
        vm.startPrank(borrower);
        vm.expectRevert(bytes("DEBT_CAP"));
        vault.borrow(10_001e6);
        vm.stopPrank();
    }

    function testTermsCannotBeRepricedAfterBorrowingStarts() public {
        vm.prank(lenderA);
        vault.deposit(100_000e6);
        vm.prank(borrower);
        vault.borrow(50_000e6);

        vm.expectRevert(bytes("TERMS_LOCKED"));
        vault.setFixedAprBps(500);
    }

    function testTwoStepOwnershipProtectsRwaAdministration() public {
        vault.transferOwnership(newOwner);
        assertEq(vault.owner(), address(this), "ownership changed before acceptance");
        assertEq(vault.pendingOwner(), newOwner, "pending owner missing");

        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner, "new owner not installed");

        vm.expectRevert(bytes("NOT_OWNER"));
        vault.setPaused(true);
        vm.prank(newOwner);
        vault.setPaused(true);
        assertTrue(vault.paused(), "accepted owner cannot administer vault");
    }

    function testFactoryIssuerRevocationAndEmergencyStop() public {
        factory.setIssuer(issuer, false);
        vm.startPrank(issuer);
        vm.expectRevert(bytes("ISSUER_NOT_APPROVED"));
        factory.createVault(address(usdc), block.timestamp + 30 days, 1_000e6, "ipfs://revoked");
        vm.stopPrank();

        factory.setIssuer(issuer, true);
        factory.setCreationPaused(true);
        vm.startPrank(issuer);
        vm.expectRevert(bytes("CREATION_PAUSED"));
        factory.createVault(address(usdc), block.timestamp + 30 days, 1_000e6, "ipfs://paused");
        vm.stopPrank();
    }

    function testFactoryRejectsOverlongMaturityAndMetadata() public {
        uint256 maxMaturity = factory.MAX_VAULT_MATURITY();
        uint256 maxMetadata = factory.MAX_METADATA_URI_BYTES();

        vm.startPrank(issuer);
        vm.expectRevert(bytes("BAD_MATURITY"));
        factory.createVault(address(usdc), block.timestamp + maxMaturity + 1, 1_000e6, "ipfs://too-long");
        vm.stopPrank();

        bytes memory raw = new bytes(maxMetadata + 1);
        for (uint256 i = 0; i < raw.length; i++) raw[i] = bytes1(uint8(97));
        string memory tooLong = string(raw);
        vm.startPrank(issuer);
        vm.expectRevert(bytes("BAD_METADATA"));
        factory.createVault(address(usdc), block.timestamp + 30 days, 1_000e6, tooLong);
        vm.stopPrank();
    }

    function testFactoryRejectsEmptyMetadataAndZeroDebtCap() public {
        vm.startPrank(issuer);
        vm.expectRevert(bytes("BAD_METADATA"));
        factory.createVault(address(usdc), block.timestamp + 30 days, 1_000e6, "");
        vm.expectRevert(bytes("ZERO_DEBT_CAP"));
        factory.createVault(address(usdc), block.timestamp + 30 days, 0, "ipfs://zero-cap");
        vm.stopPrank();
    }

    function testFactoryAcceptsExactMaturityAndMetadataBoundaries() public {
        uint256 maxMaturity = factory.MAX_VAULT_MATURITY();
        uint256 maxMetadata = factory.MAX_METADATA_URI_BYTES();
        bytes memory raw = new bytes(maxMetadata);
        for (uint256 i = 0; i < raw.length; i++) raw[i] = bytes1(uint8(97));

        vm.prank(issuer);
        address created = factory.createVault(
            address(usdc),
            block.timestamp + maxMaturity,
            1_000e6,
            string(raw)
        );

        assertTrue(factory.isVault(created), "boundary vault not registered");
        assertEq(factory.vaultIssuer(created), issuer, "boundary vault issuer mismatch");
    }

    function testFactoryRegistryTracksEveryCreatedVault() public {
        vm.startPrank(issuer);
        address a = factory.createVault(address(usdc), block.timestamp + 30 days, 10_000e6, "ipfs://vault-a");
        address b = factory.createVault(address(usdc), block.timestamp + 60 days, 20_000e6, "ipfs://vault-b");
        vm.stopPrank();

        assertEq(factory.vaultCount(), 2, "vault count mismatch");
        assertTrue(factory.isVault(a) && factory.isVault(b), "vault registry missing entry");
        assertEq(factory.vaultIssuer(a), issuer, "issuer registry mismatch A");
        assertEq(factory.vaultIssuer(b), issuer, "issuer registry mismatch B");
    }
}
