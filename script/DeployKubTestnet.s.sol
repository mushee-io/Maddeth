// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {BitkubOracleAdapter} from "../contracts/BitkubOracleAdapter.sol";
import {RwaVaultFactory} from "../contracts/RwaVaultFactory.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {WrappedTKUB} from "../contracts/mocks/WrappedTKUB.sol";

interface VmDeploy {
    function envUint(string calldata key) external returns (uint256 value);
    function addr(uint256 privateKey) external returns (address keyAddr);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Testnet-only deployment for chain id 25925.
/// @dev Never commit PRIVATE_KEY. Run with KUB_TESTNET_RPC_URL + PRIVATE_KEY environment variables.
contract DeployKubTestnet {
    VmDeploy internal constant VM = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Bitkub/BKC Oracle KUB Testnet proxy addresses from the official oracle documentation.
    address internal constant KUB_USDT_FEED = 0x6Cc1316A9695E435875A5CDA6e60066114f8A395;
    address internal constant USDC_USDT_FEED = 0x6f1373EC8d0562be98a98FE46844f057284B7A61;

    function run()
        external
        returns (
            address poolAddress,
            address oracleAddress,
            address rateModelAddress,
            address wrappedKubAddress,
            address mockUsdcAddress,
            address mockUsdtAddress,
            address rwaFactoryAddress
        )
    {
        require(block.chainid == 25925, "NOT_KUB_TESTNET");
        uint256 privateKey = VM.envUint("PRIVATE_KEY");
        address deployer = VM.addr(privateKey);

        VM.startBroadcast(privateKey);

        WrappedTKUB wrappedKub = new WrappedTKUB();
        MockERC20 mockUsdc = new MockERC20("Maddeth Test USDC", "mUSDC", 6);
        MockERC20 mockUsdt = new MockERC20("Maddeth Test USDT", "mUSDT", 6);

        BitkubOracleAdapter oracle = new BitkubOracleAdapter(deployer);
        oracle.setFeed(address(wrappedKub), KUB_USDT_FEED, 30 minutes, true);
        oracle.setFeed(address(mockUsdc), USDC_USDT_FEED, 30 minutes, true);
        oracle.setUsdPeg(address(mockUsdt), true);

        InterestRateModel rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        MaddethPool pool = new MaddethPool(address(oracle));
        RwaVaultFactory rwaFactory = new RwaVaultFactory();

        pool.configureMarket(
            address(wrappedKub),
            MaddethPool.MarketConfig({
                listed: true,
                paused: false,
                ltvBps: 7_000,
                liquidationThresholdBps: 8_000,
                liquidationBonusBps: 500,
                reserveFactorBps: 1_000,
                supplyCap: uint128(2_000_000 ether),
                borrowCap: uint128(1_000_000 ether),
                rateModel: address(rateModel)
            })
        );

        pool.configureMarket(
            address(mockUsdc),
            MaddethPool.MarketConfig({
                listed: true,
                paused: false,
                ltvBps: 8_000,
                liquidationThresholdBps: 8_500,
                liquidationBonusBps: 400,
                reserveFactorBps: 1_000,
                supplyCap: uint128(10_000_000e6),
                borrowCap: uint128(8_000_000e6),
                rateModel: address(rateModel)
            })
        );

        pool.configureMarket(
            address(mockUsdt),
            MaddethPool.MarketConfig({
                listed: true,
                paused: false,
                ltvBps: 8_000,
                liquidationThresholdBps: 8_500,
                liquidationBonusBps: 400,
                reserveFactorBps: 1_000,
                supplyCap: uint128(10_000_000e6),
                borrowCap: uint128(8_000_000e6),
                rateModel: address(rateModel)
            })
        );

        // Demo liquidity assets only. These mocks are intentionally mintable and must never be treated as real stablecoins.
        mockUsdc.mint(deployer, 2_000_000e6);
        mockUsdt.mint(deployer, 2_000_000e6);
        rwaFactory.setIssuer(deployer, true);

        VM.stopBroadcast();

        return (
            address(pool),
            address(oracle),
            address(rateModel),
            address(wrappedKub),
            address(mockUsdc),
            address(mockUsdt),
            address(rwaFactory)
        );
    }
}
