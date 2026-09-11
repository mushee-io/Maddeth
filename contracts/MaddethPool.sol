// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title MaddethPool
/// @notice KUB-testnet lending core for approved ERC-20 markets.
/// @dev Early testnet code. Audit required before mainnet use.
contract MaddethPool {
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 public constant MAX_ORACLE_AGE = 30 minutes;
    uint256 public constant CLOSE_FACTOR_BPS = 5_000; // max 50% of a debt position per liquidation

    struct MarketConfig {
        bool listed;
        bool paused;
        uint16 ltvBps;
        uint16 liquidationThresholdBps;
        uint16 liquidationBonusBps;
        uint128 supplyCap;
        uint128 borrowCap;
        uint256 totalSupplied;
        uint256 totalBorrowed;
    }

    address public owner;
    address public riskAdmin;
    IPriceOracle public oracle;
    bool private entered;

    mapping(address => MarketConfig) public markets;
    address[] public listedAssets;
    mapping(address => mapping(address => uint256)) public supplied;
    mapping(address => mapping(address => uint256)) public borrowed;
    mapping(address => mapping(address => bool)) public collateralEnabled;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RiskAdminUpdated(address indexed newRiskAdmin);
    event OracleUpdated(address indexed newOracle);
    event MarketConfigured(address indexed asset, uint16 ltvBps, uint16 liquidationThresholdBps, uint128 supplyCap, uint128 borrowCap);
    event MarketPaused(address indexed asset, bool paused);
    event Supplied(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount);
    event Borrowed(address indexed user, address indexed asset, uint256 amount);
    event Repaid(address indexed user, address indexed asset, uint256 amount);
    event CollateralToggled(address indexed user, address indexed asset, bool enabled);
    event Liquidated(address indexed user, address indexed debtAsset, address indexed collateralAsset, uint256 repaid, uint256 seized);

    modifier onlyOwner() { require(msg.sender == owner, "NOT_OWNER"); _; }
    modifier onlyRisk() { require(msg.sender == owner || msg.sender == riskAdmin, "NOT_RISK_ADMIN"); _; }
    modifier nonReentrant() { require(!entered, "REENTRANCY"); entered = true; _; entered = false; }

    constructor(address _oracle) {
        require(_oracle != address(0), "ZERO_ORACLE");
        owner = msg.sender;
        riskAdmin = msg.sender;
        oracle = IPriceOracle(_oracle);
        emit OwnershipTransferred(address(0), msg.sender);
        emit RiskAdminUpdated(msg.sender);
        emit OracleUpdated(_oracle);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setRiskAdmin(address admin) external onlyOwner {
        require(admin != address(0), "ZERO_ADMIN");
        riskAdmin = admin;
        emit RiskAdminUpdated(admin);
    }

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "ZERO_ORACLE");
        oracle = IPriceOracle(newOracle);
        emit OracleUpdated(newOracle);
    }

    function configureMarket(address asset, MarketConfig calldata m) external onlyRisk {
        require(asset != address(0), "ZERO_ASSET");
        require(m.ltvBps < m.liquidationThresholdBps, "LTV_GE_THRESHOLD");
        require(m.liquidationThresholdBps < BPS, "BAD_THRESHOLD");
        require(m.liquidationBonusBps <= 2_000, "BONUS_TOO_HIGH");
        if (!markets[asset].listed) listedAssets.push(asset);
        MarketConfig storage x = markets[asset];
        x.listed = true;
        x.paused = m.paused;
        x.ltvBps = m.ltvBps;
        x.liquidationThresholdBps = m.liquidationThresholdBps;
        x.liquidationBonusBps = m.liquidationBonusBps;
        x.supplyCap = m.supplyCap;
        x.borrowCap = m.borrowCap;
        emit MarketConfigured(asset, m.ltvBps, m.liquidationThresholdBps, m.supplyCap, m.borrowCap);
    }

    function setPaused(address asset, bool paused) external onlyRisk {
        require(markets[asset].listed, "UNLISTED");
        markets[asset].paused = paused;
        emit MarketPaused(asset, paused);
    }

    function marketCount() external view returns (uint256) { return listedAssets.length; }

    function supply(address asset, uint256 amount) external nonReentrant {
        MarketConfig storage m = markets[asset];
        require(m.listed && !m.paused, "MARKET_UNAVAILABLE");
        require(amount > 0, "ZERO_AMOUNT");
        require(m.supplyCap == 0 || m.totalSupplied + amount <= m.supplyCap, "SUPPLY_CAP");
        _safeTransferFrom(asset, msg.sender, address(this), amount);
        supplied[msg.sender][asset] += amount;
        m.totalSupplied += amount;
        emit Supplied(msg.sender, asset, amount);
    }

    function setCollateral(address asset, bool enabled) external {
        require(markets[asset].listed, "UNLISTED");
        collateralEnabled[msg.sender][asset] = enabled;
        if (!enabled) require(_accountHealthy(msg.sender), "WOULD_UNDERCOLLATERALIZE");
        emit CollateralToggled(msg.sender, asset, enabled);
    }

    function withdraw(address asset, uint256 amount) external nonReentrant {
        MarketConfig storage m = markets[asset];
        require(m.listed && !m.paused, "MARKET_UNAVAILABLE");
        require(amount > 0 && supplied[msg.sender][asset] >= amount, "BAD_AMOUNT");
        supplied[msg.sender][asset] -= amount;
        m.totalSupplied -= amount;
        require(_accountHealthy(msg.sender), "WOULD_UNDERCOLLATERALIZE");
        _safeTransfer(asset, msg.sender, amount);
        emit Withdrawn(msg.sender, asset, amount);
    }

    function borrow(address asset, uint256 amount) external nonReentrant {
        MarketConfig storage m = markets[asset];
        require(m.listed && !m.paused, "MARKET_UNAVAILABLE");
        require(amount > 0, "ZERO_AMOUNT");
        require(m.borrowCap == 0 || m.totalBorrowed + amount <= m.borrowCap, "BORROW_CAP");
        require(IERC20Minimal(asset).balanceOf(address(this)) >= amount, "INSUFFICIENT_LIQUIDITY");
        borrowed[msg.sender][asset] += amount;
        m.totalBorrowed += amount;
        require(_withinBorrowLimit(msg.sender), "LTV_EXCEEDED");
        _safeTransfer(asset, msg.sender, amount);
        emit Borrowed(msg.sender, asset, amount);
    }

    function repay(address asset, uint256 amount) external nonReentrant returns (uint256 paid) {
        uint256 debt = borrowed[msg.sender][asset];
        require(debt > 0 && amount > 0, "NO_DEBT");
        paid = amount > debt ? debt : amount;
        _safeTransferFrom(asset, msg.sender, address(this), paid);
        borrowed[msg.sender][asset] = debt - paid;
        markets[asset].totalBorrowed -= paid;
        emit Repaid(msg.sender, asset, paid);
    }

    function liquidate(address user, address debtAsset, address collateralAsset, uint256 repayAmount) external nonReentrant {
        require(!_accountHealthy(user), "ACCOUNT_HEALTHY");
        MarketConfig storage debtM = markets[debtAsset];
        MarketConfig storage colM = markets[collateralAsset];
        require(debtM.listed && colM.listed, "UNLISTED");
        require(collateralEnabled[user][collateralAsset], "NOT_COLLATERAL");
        uint256 debt = borrowed[user][debtAsset];
        require(debt > 0 && repayAmount > 0, "NO_DEBT");
        uint256 maxClose = debt * CLOSE_FACTOR_BPS / BPS;
        uint256 paid = repayAmount > maxClose ? maxClose : repayAmount;
        if (paid == 0) paid = debt;

        (uint256 debtPrice,) = _validPrice(debtAsset);
        (uint256 colPrice,) = _validPrice(collateralAsset);
        uint8 debtDec = IERC20Minimal(debtAsset).decimals();
        uint8 colDec = IERC20Minimal(collateralAsset).decimals();
        uint256 debtUsd = paid * debtPrice / (10 ** debtDec);
        uint256 seizeUsd = debtUsd * (BPS + colM.liquidationBonusBps) / BPS;
        uint256 seize = seizeUsd * (10 ** colDec) / colPrice;
        uint256 availableCollateral = supplied[user][collateralAsset];
        if (seize > availableCollateral) seize = availableCollateral;
        require(seize > 0, "NO_COLLATERAL");

        _safeTransferFrom(debtAsset, msg.sender, address(this), paid);
        borrowed[user][debtAsset] -= paid;
        debtM.totalBorrowed -= paid;
        supplied[user][collateralAsset] -= seize;
        colM.totalSupplied -= seize;
        _safeTransfer(collateralAsset, msg.sender, seize);
        emit Liquidated(user, debtAsset, collateralAsset, paid, seize);
    }

    function getAccountLiquidity(address user) public view returns (
        uint256 collateralUsd,
        uint256 borrowLimitUsd,
        uint256 liquidationLimitUsd,
        uint256 debtUsd
    ) {
        uint256 len = listedAssets.length;
        for (uint256 i; i < len; ++i) {
            address asset = listedAssets[i];
            uint256 supplyAmount = supplied[user][asset];
            uint256 debtAmount = borrowed[user][asset];
            MarketConfig storage m = markets[asset];
            if (supplyAmount > 0 && collateralEnabled[user][asset]) {
                uint256 value = _usdValue(asset, supplyAmount);
                collateralUsd += value;
                borrowLimitUsd += value * m.ltvBps / BPS;
                liquidationLimitUsd += value * m.liquidationThresholdBps / BPS;
            }
            if (debtAmount > 0) debtUsd += _usdValue(asset, debtAmount);
        }
    }

    function healthFactor(address user) external view returns (uint256) {
        (, , uint256 liquidationLimitUsd, uint256 debtUsd) = getAccountLiquidity(user);
        if (debtUsd == 0) return type(uint256).max;
        return liquidationLimitUsd * WAD / debtUsd;
    }

    function _withinBorrowLimit(address user) internal view returns (bool) {
        (, uint256 borrowLimitUsd, , uint256 debtUsd) = getAccountLiquidity(user);
        return debtUsd <= borrowLimitUsd;
    }

    function _accountHealthy(address user) internal view returns (bool) {
        (, , uint256 liquidationLimitUsd, uint256 debtUsd) = getAccountLiquidity(user);
        return debtUsd == 0 || debtUsd <= liquidationLimitUsd;
    }

    function _validPrice(address asset) internal view returns (uint256 price, uint256 updatedAt) {
        (price, updatedAt) = oracle.getPrice(asset);
        require(price > 0, "INVALID_PRICE");
        require(updatedAt <= block.timestamp, "FUTURE_PRICE");
        require(block.timestamp - updatedAt <= MAX_ORACLE_AGE, "STALE_PRICE");
    }

    function _usdValue(address asset, uint256 amount) internal view returns (uint256) {
        (uint256 price,) = _validPrice(asset);
        return amount * price / (10 ** IERC20Minimal(asset).decimals());
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TOKEN_TRANSFER_FAILED");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TOKEN_TRANSFER_FROM_FAILED");
    }
}
