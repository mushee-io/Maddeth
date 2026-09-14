// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @dev TEST ONLY. Allows deterministic zero, stale and future-price scenarios.
///      Never use this oracle for canonical or production markets.
contract FaultyPriceOracle is IPriceOracle {
    struct Price {
        uint256 value;
        uint256 updatedAt;
    }

    mapping(address => Price) public prices;

    function setPrice(address asset, uint256 value, uint256 updatedAt) external {
        prices[asset] = Price({value: value, updatedAt: updatedAt});
    }

    function setNow(address asset, uint256 value) external {
        prices[asset] = Price({value: value, updatedAt: block.timestamp});
    }

    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt) {
        Price memory p = prices[asset];
        return (p.value, p.updatedAt);
    }
}
