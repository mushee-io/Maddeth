// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MaddethPool} from "../contracts/MaddethPool.sol";
import {MaddethLens} from "../contracts/MaddethLens.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {BitkubOracleAdapter} from "../contracts/BitkubOracleAdapter.sol";
import {RwaVaultFactory} from "../contracts/RwaVaultFactory.sol";
import {IsolatedRwaVault} from "../contracts/IsolatedRwaVault.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {WrappedTKUB} from "../contracts/mocks/WrappedTKUB.sol";

interface VmDeploy {
    function envUint(string calldata key) external returns (uint256 value);
    function addr(uint256 privateKey) external returns (address keyAddr);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function serializeString(string calldata objectKey, string calldata valueKey, string calldata value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
}

/// @notice Complete testnet deployment for KUB Chain testnet (chain id 25925).
/// @dev Never commit PRIVATE_KEY. Mock stablecoins and the sample RWA vault are TESTNET ONLY.
contract DeployKubTestnet {
    VmDeploy internal constant VM = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    // KUB Testnet oracle feed proxies currently configured for Maddeth.
    // Re-confirm these against the KUB Developer Center immediately before each real broadcast.
    address internal constant KUB_USDT_FEED = 0x6Cc1316A9695E435875A5CDA6e60066114f8A395;
    address internal constant USDC_USDT_FEED = 0x6f1373EC8d0562be98a98FE46844f057284B7A61;

    uint256 internal constant INITIAL_STABLE_LIQUIDITY = 1_000_000e6;
    uint256 internal constant DEMO_RWA_DEBT_CAP = 500_000e6;
    uint16 internal constant DEMO_RWA_APR_BPS = 900;

    function run()
        external
        returns (
            address poolAddress,
            address lensAddress,
            address oracleAddress,
            address rateModelAddress,
            address wrappedKubAddress,
            address mockUsdcAddress,
            address mockUsdtAddress,
            address rwaFactoryAddress,
            address sampleRwaVaultAddress
        )
    {
        require(block.chainid == 25925, "NOT_KUB_TESTNET");
        uint256 privateKey = VM.envUint("PRIVATE_KEY");
        address deployer = VM.addr(privateKey);

        VM.startBroadcast(privateKey);

        // TESTNET assets. They must never be reused or presented as production stablecoins.
        WrappedTKUB wrappedKub = new WrappedTKUB();
        MockERC20 mockUsdc = new MockERC20("Maddeth Test USDC", "mUSDC", 6);
        MockERC20 mockUsdt = new MockERC20("Maddeth Test USDT", "mUSDT", 6);

        BitkubOracleAdapter oracle = new BitkubOracleAdapter(deployer);
        oracle.setFeed(address(wrappedKub), KUB_USDT_FEED, 30 minutes, true);
        oracle.setFeed(address(mockUsdc), USDC_USDT_FEED, 30 minutes, true);
        // Explicit testnet convenience. Production stablecoin collateral requires a depeg-aware oracle policy.
        oracle.setUsdPeg(address(mockUsdt), true);

        InterestRateModel rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        MaddethPool pool = new MaddethPool(address(oracle));
        MaddethLens lens = new MaddethLens(address(pool));
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

        // Seed borrowable TESTNET liquidity so a fresh deployment is usable immediately.
        mockUsdc.mint(deployer, INITIAL_STABLE_LIQUIDITY);
        mockUsdt.mint(deployer, INITIAL_STABLE_LIQUIDITY);
        mockUsdc.approve(address(pool), type(uint256).max);
        mockUsdt.approve(address(pool), type(uint256).max);
        pool.supply(address(mockUsdc), INITIAL_STABLE_LIQUIDITY);
        pool.supply(address(mockUsdt), INITIAL_STABLE_LIQUIDITY);

        // Register one explicitly labelled demo RWA vault. No production issuer or off-chain asset is implied.
        rwaFactory.setIssuer(deployer, true);
        address sampleRwaVault = rwaFactory.createVault(
            address(mockUsdc),
            block.timestamp + 90 days,
            DEMO_RWA_DEBT_CAP,
            "testnet-demo://maddeth/kub-invoice-credit-v1"
        );
        IsolatedRwaVault(sampleRwaVault).setFixedAprBps(DEMO_RWA_APR_BPS);
        IsolatedRwaVault(sampleRwaVault).setLender(deployer, true);

        VM.stopBroadcast();

        _writeManifest(
            deployer,
            address(pool),
            address(lens),
            address(oracle),
            address(rateModel),
            address(wrappedKub),
            address(mockUsdc),
            address(mockUsdt),
            address(rwaFactory),
            sampleRwaVault
        );

        return (
            address(pool),
            address(lens),
            address(oracle),
            address(rateModel),
            address(wrappedKub),
            address(mockUsdc),
            address(mockUsdt),
            address(rwaFactory),
            sampleRwaVault
        );
    }

    function _writeManifest(
        address deployer,
        address pool,
        address lens,
        address oracle,
        address rateModel,
        address wrappedKub,
        address mockUsdc,
        address mockUsdt,
        address rwaFactory,
        address sampleRwaVault
    ) internal {
        string memory key = "deployment";
        VM.serializeString(key, "network", "KUB Testnet");
        VM.serializeUint(key, "chainId", 25925);
        VM.serializeUint(key, "generatedAt", block.timestamp);
        VM.serializeUint(key, "blockNumber", block.number);
        VM.serializeAddress(key, "deployer", deployer);
        VM.serializeAddress(key, "maddethPool", pool);
        VM.serializeAddress(key, "maddethLens", lens);
        VM.serializeAddress(key, "oracle", oracle);
        VM.serializeAddress(key, "interestRateModel", rateModel);
        VM.serializeAddress(key, "wrappedKUB", wrappedKub);
        VM.serializeAddress(key, "testUSDC", mockUsdc);
        VM.serializeAddress(key, "testUSDT", mockUsdt);
        VM.serializeAddress(key, "rwaVaultFactory", rwaFactory);
        string memory json = VM.serializeAddress(key, "sampleRwaVault", sampleRwaVault);
        VM.writeJson(json, "./deployment-kub-testnet.json");
    }
}
