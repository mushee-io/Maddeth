// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @dev TEST ONLY. Never deploy as a production oracle.
contract MockPriceOracle is IPriceOracle {
    struct Price { uint256 value; uint256 updatedAt; }
    mapping(address => Price) public prices;
    function setPrice(address asset, uint256 value) external { prices[asset] = Price(value, block.timestamp); }
    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt) { Price memory p = prices[asset]; return (p.value, p.updatedAt); }
}
