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
/// @dev Resumable after a partially mined previous smoke run. Uses deliberately tiny amounts.
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

        VM.startBroadcast(privateKey);

        // Recover safely from a previous smoke run that mined only part of the lifecycle.
        uint256 staleDebt = pool.borrowed(account, usdcAddress);
        if (staleDebt > 0) {
            require(usdc.balanceOf(account) >= staleDebt, "RECOVERY_USDC_MISSING");
            usdc.approve(poolAddress, type(uint256).max);
            pool.repay(usdcAddress, type(uint256).max);
        }

        if (pool.collateralEnabled(account, wrappedAddress)) {
            pool.setCollateral(wrappedAddress, false);
        }

        uint256 staleSupply = pool.supplied(account, wrappedAddress);
        if (staleSupply > 0) {
            pool.withdraw(wrappedAddress, staleSupply);
            wrapped.withdraw(staleSupply);
        }

        require(pool.borrowed(account, usdcAddress) == 0, "RECOVERY_DEBT_REMAINS");
        require(pool.supplied(account, wrappedAddress) == 0, "RECOVERY_SUPPLY_REMAINS");
        require(!pool.collateralEnabled(account, wrappedAddress), "RECOVERY_COLLATERAL_REMAINS");

        uint256 wrappedBaseline = wrapped.balanceOf(account);

        // Fresh end-to-end lifecycle.
        wrapped.deposit{value: WRAP_AMOUNT}();
        wrapped.approve(poolAddress, WRAP_AMOUNT);
        pool.supply(wrappedAddress, WRAP_AMOUNT);
        pool.setCollateral(wrappedAddress, true);

        pool.borrow(usdcAddress, BORROW_AMOUNT);
        require(pool.borrowed(account, usdcAddress) >= BORROW_AMOUNT, "BORROW_NOT_RECORDED");

        usdc.approve(poolAddress, type(uint256).max);
        pool.repay(usdcAddress, type(uint256).max);
        require(pool.borrowed(account, usdcAddress) == 0, "REPAY_NOT_CLEARED");

        pool.setCollateral(wrappedAddress, false);
        pool.withdraw(wrappedAddress, WRAP_AMOUNT);
        require(pool.supplied(account, wrappedAddress) == 0, "WITHDRAW_NOT_CLEARED");

        wrapped.withdraw(WRAP_AMOUNT);

        VM.stopBroadcast();

        require(wrapped.balanceOf(account) == wrappedBaseline, "WRAPPED_BALANCE_MISMATCH");
        require(pool.borrowed(account, usdcAddress) == 0, "FINAL_DEBT_REMAINS");
        require(pool.supplied(account, wrappedAddress) == 0, "FINAL_SUPPLY_REMAINS");
        require(!pool.collateralEnabled(account, wrappedAddress), "FINAL_COLLATERAL_REMAINS");
    }
}
