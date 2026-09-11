// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/// @title BitkubOracleAdapter
/// @notice Normalizes Bitkub/BKC Oracle data-feed proxy prices to 1e18 USD precision.
/// @dev The adapter itself must be allowlisted/subscribed as a consumer when Bitkub Oracle requires it.
contract BitkubOracleAdapter is IPriceOracle {
    struct FeedConfig {
        address feed;
        uint32 heartbeat;
        bool enabled;
    }

    address public owner;
    mapping(address => FeedConfig) public feeds;
    mapping(address => bool) public usdPegged;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeedConfigured(address indexed asset, address indexed feed, uint32 heartbeat, bool enabled);
    event UsdPegConfigured(address indexed asset, bool enabled);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address _owner) {
        require(_owner != address(0), "ZERO_OWNER");
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setFeed(address asset, address feed, uint32 heartbeat, bool enabled) external onlyOwner {
        require(asset != address(0), "ZERO_ASSET");
        require(feed != address(0), "ZERO_FEED");
        require(heartbeat > 0 && heartbeat <= 1 days, "BAD_HEARTBEAT");
        uint8 feedDecimals = IAggregatorV3(feed).decimals();
        require(feedDecimals <= 36, "BAD_DECIMALS");
        feeds[asset] = FeedConfig({feed: feed, heartbeat: heartbeat, enabled: enabled});
        if (enabled) usdPegged[asset] = false;
        emit FeedConfigured(asset, feed, heartbeat, enabled);
    }

    /// @notice Testnet/explicit-risk convenience for assets intentionally treated as $1.
    /// @dev Do not use for production collateral without a governance-approved depeg policy.
    function setUsdPeg(address asset, bool enabled) external onlyOwner {
        require(asset != address(0), "ZERO_ASSET");
        usdPegged[asset] = enabled;
        if (enabled) feeds[asset].enabled = false;
        emit UsdPegConfigured(asset, enabled);
    }

    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt) {
        if (usdPegged[asset]) return (1e18, block.timestamp);

        FeedConfig memory cfg = feeds[asset];
        require(cfg.enabled && cfg.feed != address(0), "FEED_NOT_CONFIGURED");

        IAggregatorV3 aggregator = IAggregatorV3(cfg.feed);
        (uint80 roundId, int256 answer,, uint256 timestamp, uint80 answeredInRound) = aggregator.latestRoundData();
        require(answer > 0, "BAD_ANSWER");
        require(timestamp > 0 && timestamp <= block.timestamp, "BAD_TIMESTAMP");
        require(answeredInRound >= roundId, "INCOMPLETE_ROUND");
        require(block.timestamp - timestamp <= cfg.heartbeat, "FEED_STALE");

        uint8 decimals_ = aggregator.decimals();
        uint256 unsignedAnswer = uint256(answer);
        if (decimals_ == 18) {
            price = unsignedAnswer;
        } else if (decimals_ < 18) {
            price = unsignedAnswer * (10 ** (18 - decimals_));
        } else {
            price = unsignedAnswer / (10 ** (decimals_ - 18));
        }
        require(price > 0, "ZERO_PRICE");
        updatedAt = timestamp;
    }
}
