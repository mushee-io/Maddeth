// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MaddethPool} from "../contracts/MaddethPool.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {WrappedTKUB} from "../contracts/mocks/WrappedTKUB.sol";

interface VmSmoke {
    function envUint(string calldata key) external returns (uint256 value);
    function envAddress(string calldata key) external returns (address value);
    function addr(uint256 privateKey) external returns (address keyAddr);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @title SmokeKubTestnet
/// @notice Executes the minimum real Maddeth lifecycle after a KUB Testnet deployment.
/// @dev Uses deliberately tiny amounts. A passing run proves wrap -> supply -> collateral -> borrow -> repay -> withdraw -> unwrap.
contract SmokeKubTestnet {
    VmSmoke internal constant VM = VmSmoke(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant WRAP_AMOUNT = 0.01 ether;
    uint256 internal constant BORROW_AMOUNT = 1; // 0.000001 mUSDC

    function run() external {
        require(block.chainid == 25925, "NOT_KUB_TESTNET");

        uint256 privateKey = VM.envUint("PRIVATE_KEY");
        address account = VM.addr(privateKey);
        address poolAddress = VM.envAddress("MADDETH_POOL");
        address wrappedAddress = VM.envAddress("WRAPPED_KUB");
        address usdcAddress = VM.envAddress("TEST_USDC");

        require(poolAddress != address(0) && wrappedAddress != address(0) && usdcAddress != address(0), "MISSING_ADDRESS");
        require(account.balance > WRAP_AMOUNT, "INSUFFICIENT_TKUB");

        MaddethPool pool = MaddethPool(poolAddress);
        WrappedTKUB wrapped = WrappedTKUB(payable(wrappedAddress));
        MockERC20 usdc = MockERC20(usdcAddress);

        uint256 wrappedBefore = wrapped.balanceOf(account);
        uint256 suppliedBefore = pool.supplied(account, wrappedAddress);
        uint256 debtBefore = pool.borrowed(account, usdcAddress);
        require(debtBefore == 0, "SMOKE_REQUIRES_ZERO_USDC_DEBT");

        VM.startBroadcast(privateKey);

        wrapped.deposit{value: WRAP_AMOUNT}();
        wrapped.approve(poolAddress, WRAP_AMOUNT);
        pool.supply(wrappedAddress, WRAP_AMOUNT);
        pool.setCollateral(wrappedAddress, true);

        pool.borrow(usdcAddress, BORROW_AMOUNT);
        require(pool.borrowed(account, usdcAddress) >= BORROW_AMOUNT, "BORROW_NOT_RECORDED");

        usdc.approve(poolAddress, type(uint256).max);
        pool.repay(usdcAddress, type(uint256).max);
        require(pool.borrowed(account, usdcAddress) == 0, "REPAY_NOT_CLEARED");

        pool.withdraw(wrappedAddress, WRAP_AMOUNT);
        require(pool.supplied(account, wrappedAddress) == suppliedBefore, "WITHDRAW_NOT_CLEARED");

        wrapped.withdraw(WRAP_AMOUNT);

        VM.stopBroadcast();

        // Foundry simulates a script before broadcasting it. Simulation does not debit
        // transaction gas from `account.balance`, so a native-balance gas assertion is
        // not a valid smoke-test invariant and can make an otherwise successful lifecycle
        // revert before any transactions are broadcast. Validate protocol state instead.
        require(wrapped.balanceOf(account) == wrappedBefore, "WRAPPED_BALANCE_NOT_RESTORED");
        require(pool.supplied(account, wrappedAddress) == suppliedBefore, "SUPPLY_NOT_RESTORED");
        require(pool.borrowed(account, usdcAddress) == debtBefore, "DEBT_NOT_RESTORED");
    }
}
