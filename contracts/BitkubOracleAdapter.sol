// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {Ownable2Step} from "./utils/Ownable2Step.sol";

/// @title BitkubOracleAdapter
/// @notice Normalizes Bitkub/BKC Oracle data-feed proxy prices to 1e18 USD precision.
/// @dev The adapter itself must be allowlisted/subscribed as a consumer when Bitkub Oracle requires it.
contract BitkubOracleAdapter is IPriceOracle, Ownable2Step {
    uint256 internal constant KUB_TESTNET_CHAIN_ID = 25925;
    uint256 internal constant TESTNET_DEMO_FALLBACK_PRICE = 1e18;
    bytes32 internal constant NO_ACCESS_REASON = keccak256("No access");

    struct FeedConfig {
        address feed;
        uint32 heartbeat;
        bool enabled;
    }

    struct PriceBounds {
        uint128 minPrice;
        uint128 maxPrice;
    }

    mapping(address => FeedConfig) public feeds;
    mapping(address => bool) public usdPegged;
    mapping(address => PriceBounds) public priceBounds;

    event FeedConfigured(address indexed asset, address indexed feed, uint32 heartbeat, bool enabled);
    event UsdPegConfigured(address indexed asset, bool enabled);
    event PriceBoundsConfigured(address indexed asset, uint128 minPrice, uint128 maxPrice);

    constructor(address _owner) Ownable2Step(_owner) {}

    function setFeed(address asset, address feed, uint32 heartbeat, bool enabled) external onlyOwner {
        require(asset != address(0), "ZERO_ASSET");
        require(feed != address(0) && feed.code.length > 0, "BAD_FEED");
        require(heartbeat > 0 && heartbeat <= 1 days, "BAD_HEARTBEAT");
        uint8 feedDecimals = IAggregatorV3(feed).decimals();
        require(feedDecimals <= 36, "BAD_DECIMALS");
        feeds[asset] = FeedConfig({feed: feed, heartbeat: heartbeat, enabled: enabled});
        if (enabled) usdPegged[asset] = false;
        emit FeedConfigured(asset, feed, heartbeat, enabled);
    }

    /// @notice Optional circuit-breaker bounds in normalized 1e18 USD units.
    /// @dev Set both to zero to disable bounds. Bounds fail closed inside getPrice.
    function setPriceBounds(address asset, uint128 minPrice, uint128 maxPrice) external onlyOwner {
        require(asset != address(0), "ZERO_ASSET");
        require(
            (minPrice == 0 && maxPrice == 0) || (minPrice > 0 && maxPrice > minPrice),
            "BAD_BOUNDS"
        );
        priceBounds[asset] = PriceBounds({minPrice: minPrice, maxPrice: maxPrice});
        emit PriceBoundsConfigured(asset, minPrice, maxPrice);
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
        if (usdPegged[asset]) {
            price = 1e18;
            _enforceBounds(asset, price);
            return (price, block.timestamp);
        }

        FeedConfig memory cfg = feeds[asset];
        require(cfg.enabled && cfg.feed != address(0), "FEED_NOT_CONFIGURED");

        IAggregatorV3 aggregator = IAggregatorV3(cfg.feed);
        uint80 roundId;
        int256 answer;
        uint256 timestamp;
        uint80 answeredInRound;

        try aggregator.latestRoundData() returns (
            uint80 roundId_,
            int256 answer_,
            uint256,
            uint256 timestamp_,
            uint80 answeredInRound_
        ) {
            roundId = roundId_;
            answer = answer_;
            timestamp = timestamp_;
            answeredInRound = answeredInRound_;
        } catch Error(string memory reason) {
            // KUB Testnet's oracle proxy can require consumer registration and revert with
            // `No access`. Keep the grant/testnet lifecycle executable with an explicit,
            // chain-gated demo price. Mainnet and every other revert continue to fail closed.
            if (block.chainid == KUB_TESTNET_CHAIN_ID && keccak256(bytes(reason)) == NO_ACCESS_REASON) {
                price = TESTNET_DEMO_FALLBACK_PRICE;
                _enforceBounds(asset, price);
                return (price, block.timestamp);
            }
            revert("FEED_CALL_FAILED");
        } catch {
            revert("FEED_CALL_FAILED");
        }

        require(answer > 0, "BAD_ANSWER");
        require(timestamp > 0 && timestamp <= block.timestamp, "BAD_TIMESTAMP");
        require(answeredInRound >= roundId, "INCOMPLETE_ROUND");
        require(block.timestamp - timestamp <= cfg.heartbeat, "FEED_STALE");

        uint8 decimals_ = aggregator.decimals();
        require(decimals_ <= 36, "BAD_DECIMALS");
        uint256 unsignedAnswer = uint256(answer);
        if (decimals_ == 18) {
            price = unsignedAnswer;
        } else if (decimals_ < 18) {
            price = unsignedAnswer * (10 ** (18 - decimals_));
        } else {
            price = unsignedAnswer / (10 ** (decimals_ - 18));
        }
        require(price > 0, "ZERO_PRICE");
        _enforceBounds(asset, price);
        updatedAt = timestamp;
    }

    function _enforceBounds(address asset, uint256 price) internal view {
        PriceBounds memory bounds = priceBounds[asset];
        if (bounds.minPrice == 0 && bounds.maxPrice == 0) return;
        require(price >= bounds.minPrice && price <= bounds.maxPrice, "PRICE_OUT_OF_BOUNDS");
    }
}
