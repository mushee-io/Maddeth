// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @dev TEST ONLY. Chainlink-compatible mock used to exercise the Bitkub oracle adapter.
contract MockAggregatorV3 is IAggregatorV3 {
    uint8 public immutable override decimals;
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound;

    constructor(uint8 _decimals, int256 _answer) {
        decimals = _decimals;
        setRoundData(1, _answer, block.timestamp, 1);
    }

    function setAnswer(int256 newAnswer) external {
        roundId += 1;
        answer = newAnswer;
        updatedAt = block.timestamp;
        answeredInRound = roundId;
    }

    function setRoundData(uint80 newRoundId, int256 newAnswer, uint256 newUpdatedAt, uint80 newAnsweredInRound) public {
        roundId = newRoundId;
        answer = newAnswer;
        updatedAt = newUpdatedAt;
        answeredInRound = newAnsweredInRound;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
