// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MaddethPool} from "../contracts/MaddethPool.sol";
import {InterestRateModel} from "../contracts/InterestRateModel.sol";
import {BitkubOracleAdapter} from "../contracts/BitkubOracleAdapter.sol";
import {RwaVaultFactory} from "../contracts/RwaVaultFactory.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockPriceOracle} from "../contracts/mocks/MockPriceOracle.sol";
import {MockAggregatorV3} from "../contracts/mocks/MockAggregatorV3.sol";

contract FeeToken {
    string public constant name = "Fee Token";
    string public constant symbol = "FEE";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "BALANCE");
        uint256 fee = amount / 100;
        uint256 received = amount - fee;
        balanceOf[from] -= amount;
        balanceOf[to] += received;
        totalSupply -= fee;
        emit Transfer(from, to, received);
        emit Transfer(from, address(0), fee);
    }
}

contract SecurityHardeningTest is TestBase {
    MaddethPool internal pool;
    InterestRateModel internal rateModel;
    MockPriceOracle internal oracle;
    MockERC20 internal usdc;

    address internal user = address(0xA11CE);
    address internal riskAdmin = address(0xBEEF);
    address internal newOwner = address(0xCAFE);

    function setUp() public {
        oracle = new MockPriceOracle();
        rateModel = new InterestRateModel(0.02e18, 0.08e18, 0.75e18, 0.80e18);
        pool = new MaddethPool(address(oracle));
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        oracle.setPrice(address(usdc), 1e18);
        _configure(address(usdc));

        usdc.mint(user, 1_000e6);
        vm.prank(user);
        usdc.approve(address(pool), type(uint256).max);
    }

    function testOwnershipTransferRequiresAcceptance() public {
        pool.transferOwnership(newOwner);
        assertEq(pool.owner(), address(this), "owner changed before acceptance");
        assertEq(pool.pendingOwner(), newOwner, "pending owner missing");

        vm.prank(newOwner);
        pool.acceptOwnership();
        assertEq(pool.owner(), newOwner, "new owner not installed");
        assertEq(pool.pendingOwner(), address(0), "pending owner not cleared");
    }

    function testRiskAdminCanPauseButCannotUnpauseProtocol() public {
        pool.setRiskAdmin(riskAdmin);
        vm.prank(riskAdmin);
        pool.setProtocolPaused(true);
        assertTrue(pool.protocolPaused(), "protocol not paused");

        vm.startPrank(riskAdmin);
        vm.expectRevert(bytes("OWNER_REQUIRED_TO_UNPAUSE"));
        pool.setProtocolPaused(false);
        vm.stopPrank();

        pool.setProtocolPaused(false);
        assertTrue(!pool.protocolPaused(), "owner could not unpause");
    }

    function testRiskAdminCanPauseButCannotUnpauseMarket() public {
        pool.setRiskAdmin(riskAdmin);
        vm.prank(riskAdmin);
        pool.setPaused(address(usdc), true);

        vm.startPrank(riskAdmin);
        vm.expectRevert(bytes("OWNER_REQUIRED_TO_UNPAUSE"));
        pool.setPaused(address(usdc), false);
        vm.stopPrank();

        pool.setPaused(address(usdc), false);
    }

    function testPausedMarketStillAllowsSafeWithdrawal() public {
        vm.prank(user);
        pool.supply(address(usdc), 500e6);

        pool.setPaused(address(usdc), true);
        uint256 beforeBalance = usdc.balanceOf(user);
        vm.prank(user);
        pool.withdraw(address(usdc), 100e6);
        assertEq(usdc.balanceOf(user), beforeBalance + 100e6, "withdrawal blocked by emergency pause");
    }

    function testFeeOnTransferTokenIsRejected() public {
        FeeToken feeToken = new FeeToken();
        oracle.setPrice(address(feeToken), 1e18);
        _configure(address(feeToken));
        feeToken.mint(user, 1_000e6);
        vm.prank(user);
        feeToken.approve(address(pool), type(uint256).max);

        vm.startPrank(user);
        vm.expectRevert(bytes("UNSUPPORTED_TOKEN_BEHAVIOR"));
        pool.supply(address(feeToken), 100e6);
        vm.stopPrank();
    }

    function testNonContractMarketAssetRejected() public {
        MaddethPool.MarketConfig memory cfg = _config();
        vm.expectRevert(bytes("BAD_ASSET"));
        pool.configureMarket(address(0x1234), cfg);
    }

    function testOracleBoundsFailClosed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 100_000_000);
        BitkubOracleAdapter adapter = new BitkubOracleAdapter(address(this));
        adapter.setFeed(address(usdc), address(feed), 1 hours, true);
        adapter.setPriceBounds(address(usdc), uint128(0.95e18), uint128(1.05e18));

        feed.setAnswer(120_000_000);
        vm.expectRevert(bytes("PRICE_OUT_OF_BOUNDS"));
        adapter.getPrice(address(usdc));
    }

    function testFactoryCanEmergencyStopNewVaults() public {
        RwaVaultFactory factory = new RwaVaultFactory();
        factory.setIssuer(address(this), true);
        factory.setCreationPaused(true);
        vm.expectRevert(bytes("CREATION_PAUSED"));
        factory.createVault(address(usdc), block.timestamp + 30 days, 100_000e6, "testnet://blocked");
    }

    function _configure(address asset) internal {
        pool.configureMarket(asset, _config());
    }

    function _config() internal view returns (MaddethPool.MarketConfig memory) {
        return MaddethPool.MarketConfig({
            listed: true,
            paused: false,
            ltvBps: 8_000,
            liquidationThresholdBps: 8_500,
            liquidationBonusBps: 500,
            reserveFactorBps: 1_000,
            supplyCap: uint128(10_000_000e6),
            borrowCap: uint128(5_000_000e6),
            rateModel: address(rateModel)
        });
    }
}
