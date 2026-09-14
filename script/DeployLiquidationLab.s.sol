// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MaddethPool} from "../contracts/MaddethPool.sol";
import {MaddethLens} from "../contracts/MaddethLens.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {LiquidationLabOracle} from "../contracts/LiquidationLabOracle.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

interface VmLiquidationLabDeploy {
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

/// @notice Deploys a completely isolated liquidation laboratory on KUB Testnet.
/// @dev The lab never references or mutates the canonical Maddeth pool or canonical oracle.
contract DeployLiquidationLab {
    VmLiquidationLabDeploy internal constant VM =
        VmLiquidationLabDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant INITIAL_LIQUIDITY = 1_000_000e6;

    function run()
        external
        returns (
            address poolAddress,
            address lensAddress,
            address oracleAddress,
            address rateModelAddress,
            address labKubAddress,
            address labUsdcAddress
        )
    {
        require(block.chainid == 25925, "NOT_KUB_TESTNET");
        uint256 privateKey = VM.envUint("PRIVATE_KEY");
        address deployer = VM.addr(privateKey);

        VM.startBroadcast(privateKey);

        MockERC20 labKub = new MockERC20("Maddeth Liquidation Lab KUB", "labKUB", 18);
        MockERC20 labUsdc = new MockERC20("Maddeth Liquidation Lab USDC", "labUSDC", 6);
        LiquidationLabOracle oracle = new LiquidationLabOracle(address(labKub), address(labUsdc));
        InterestRateModel rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        MaddethPool pool = new MaddethPool(address(oracle));
        MaddethLens lens = new MaddethLens(address(pool));

        pool.configureMarket(
            address(labKub),
            MaddethPool.MarketConfig({
                listed: true,
                paused: false,
                ltvBps: 7_500,
                liquidationThresholdBps: 8_000,
                liquidationBonusBps: 500,
                reserveFactorBps: 1_000,
                supplyCap: uint128(10_000_000 ether),
                borrowCap: uint128(5_000_000 ether),
                rateModel: address(rateModel)
            })
        );
        pool.configureMarket(
            address(labUsdc),
            MaddethPool.MarketConfig({
                listed: true,
                paused: false,
                ltvBps: 8_000,
                liquidationThresholdBps: 8_500,
                liquidationBonusBps: 500,
                reserveFactorBps: 1_000,
                supplyCap: uint128(10_000_000e6),
                borrowCap: uint128(5_000_000e6),
                rateModel: address(rateModel)
            })
        );

        // Seed only the isolated lab pool. Tokens are intentionally public-mint test assets.
        labUsdc.mint(deployer, INITIAL_LIQUIDITY);
        labUsdc.approve(address(pool), type(uint256).max);
        pool.supply(address(labUsdc), INITIAL_LIQUIDITY);

        VM.stopBroadcast();

        string memory root = "liquidationLab";
        VM.serializeString(root, "network", "KUB Testnet");
        VM.serializeUint(root, "chainId", block.chainid);
        VM.serializeAddress(root, "deployer", deployer);
        VM.serializeAddress(root, "pool", address(pool));
        VM.serializeAddress(root, "lens", address(lens));
        VM.serializeAddress(root, "oracle", address(oracle));
        VM.serializeAddress(root, "rateModel", address(rateModel));
        VM.serializeAddress(root, "labKUB", address(labKub));
        VM.serializeAddress(root, "labUSDC", address(labUsdc));
        VM.serializeUint(root, "deploymentBlock", block.number);
        string memory json = VM.serializeUint(root, "deployedAt", block.timestamp);
        VM.writeJson(json, "deployment-kub-liquidation-lab.json");

        return (address(pool), address(lens), address(oracle), address(rateModel), address(labKub), address(labUsdc));
    }
}
