// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {BitkubOracleAdapter} from "../contracts/BitkubOracleAdapter.sol";
import {MockAggregatorV3} from "../contracts/mocks/MockAggregatorV3.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

contract BitkubOracleAdapterTest is TestBase {
    BitkubOracleAdapter internal oracle;
    MockAggregatorV3 internal feed;
    MockERC20 internal kub;
    MockERC20 internal usdt;

    function setUp() public {
        oracle = new BitkubOracleAdapter(address(this));
        feed = new MockAggregatorV3(8, 10_25000000); // $10.25 with 8 decimals
        kub = new MockERC20("Mock KUB", "mKUB", 18);
        usdt = new MockERC20("Mock USDT", "mUSDT", 6);
        oracle.setFeed(address(kub), address(feed), 30 minutes, true);
        oracle.setUsdPeg(address(usdt), true);
    }

    function testNormalizesEightDecimalFeedToWad() public {
        (uint256 price, uint256 updatedAt) = oracle.getPrice(address(kub));
        assertEq(price, 10_250000000000000000, "wrong normalized price");
        assertEq(updatedAt, block.timestamp, "wrong timestamp");
    }

    function testExplicitUsdPegReturnsOneDollar() public {
        (uint256 price, uint256 updatedAt) = oracle.getPrice(address(usdt));
        assertEq(price, 1e18, "peg price");
        assertEq(updatedAt, block.timestamp, "peg timestamp");
    }

    function testStaleFeedFailsClosed() public {
        vm.warp(block.timestamp + 31 minutes);
        vm.expectRevert(bytes("FEED_STALE"));
        oracle.getPrice(address(kub));
    }

    function testIncompleteRoundFailsClosed() public {
        feed.setRoundData(5, 10_00000000, block.timestamp, 4);
        vm.expectRevert(bytes("INCOMPLETE_ROUND"));
        oracle.getPrice(address(kub));
    }

    function testNegativeAnswerFailsClosed() public {
        feed.setAnswer(-1);
        vm.expectRevert(bytes("BAD_ANSWER"));
        oracle.getPrice(address(kub));
    }
}
