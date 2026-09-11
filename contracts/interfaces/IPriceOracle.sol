// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPriceOracle {
    /// @notice Returns USD price scaled to 1e18 and timestamp of the observation.
    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt);
}
