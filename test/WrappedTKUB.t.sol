// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {WrappedTKUB} from "../contracts/mocks/WrappedTKUB.sol";

contract WrappedTKUBTest is TestBase {
    WrappedTKUB internal wrapped;
    address internal user = address(0xBEEF);

    function setUp() public {
        wrapped = new WrappedTKUB();
        vm.deal(user, 10 ether);
    }

    function testDepositAndWithdrawNativeTKUB() public {
        vm.prank(user);
        wrapped.deposit{value: 2 ether}();
        assertEq(wrapped.balanceOf(user), 2 ether, "wrapped balance");

        vm.prank(user);
        wrapped.withdraw(1 ether);
        assertEq(wrapped.balanceOf(user), 1 ether, "remaining wrapped balance");
    }
}
