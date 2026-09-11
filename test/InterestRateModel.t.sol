// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";

contract InterestRateModelTest is TestBase {
    InterestRateModel internal model;

    function setUp() public {
        model = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
    }

    function testRatesAtZeroKinkAndFullUtilisation() public {
        assertEq(model.borrowRate(0), 0.02e18, "base rate");
        assertEq(model.borrowRate(0.80e18), 0.10e18, "kink rate");
        assertEq(model.borrowRate(1e18), 0.85e18, "full utilisation rate");
    }

    function testRateIsMonotonic() public {
        uint256 low = model.borrowRate(0.25e18);
        uint256 medium = model.borrowRate(0.75e18);
        uint256 high = model.borrowRate(0.95e18);
        assertLt(low, medium, "low >= medium");
        assertLt(medium, high, "medium >= high");
    }
}
