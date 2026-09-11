// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IInterestRateModel {
    /// @notice Annualized borrow rate, scaled to 1e18.
    function borrowRate(uint256 utilisation) external view returns (uint256);
}
