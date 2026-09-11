// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Simple kinked utilisation rate model. Rates are annualized and scaled to 1e18.
contract InterestRateModel {
    uint256 public immutable baseRate;
    uint256 public immutable slope1;
    uint256 public immutable slope2;
    uint256 public immutable kink;

    constructor(uint256 _baseRate, uint256 _slope1, uint256 _slope2, uint256 _kink) {
        require(_kink > 0 && _kink < 1e18, "BAD_KINK");
        baseRate = _baseRate;
        slope1 = _slope1;
        slope2 = _slope2;
        kink = _kink;
    }

    function borrowRate(uint256 utilisation) external view returns (uint256) {
        if (utilisation <= kink) {
            return baseRate + (slope1 * utilisation) / kink;
        }
        uint256 excess = utilisation - kink;
        return baseRate + slope1 + (slope2 * excess) / (1e18 - kink);
    }
}
