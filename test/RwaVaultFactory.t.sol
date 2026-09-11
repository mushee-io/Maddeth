// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {RwaVaultFactory} from "../contracts/RwaVaultFactory.sol";
import {IsolatedRwaVault} from "../contracts/IsolatedRwaVault.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

contract RwaVaultFactoryTest is TestBase {
    RwaVaultFactory internal factory;
    MockERC20 internal usdc;
    address internal issuer = address(0x155E);

    function setUp() public {
        factory = new RwaVaultFactory();
        usdc = new MockERC20("Mock USD Coin", "mUSDC", 6);
        factory.setIssuer(issuer, true);
    }

    function testApprovedIssuerOwnsCreatedVault() public {
        vm.prank(issuer);
        address vaultAddress = factory.createVault(
            address(usdc),
            block.timestamp + 90 days,
            1_000_000e6,
            "ipfs://maddeth-rwa-demo"
        );

        IsolatedRwaVault vault = IsolatedRwaVault(vaultAddress);
        assertEq(vault.owner(), issuer, "issuer must own vault");
        assertEq(vault.borrower(), issuer, "issuer must be borrower");
        assertEq(factory.vaultIssuer(vaultAddress), issuer, "issuer registry mismatch");
        assertTrue(factory.isVault(vaultAddress), "vault registry missing");
    }

    function testUnapprovedIssuerCannotCreateVault() public {
        address stranger = address(0xBAD);
        vm.startPrank(stranger);
        vm.expectRevert(bytes("ISSUER_NOT_APPROVED"));
        factory.createVault(address(usdc), block.timestamp + 90 days, 1_000e6, "ipfs://blocked");
        vm.stopPrank();
    }
}
