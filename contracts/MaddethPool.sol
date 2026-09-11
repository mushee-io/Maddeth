// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IInterestRateModel} from "./interfaces/IInterestRateModel.sol";

/// @title MaddethPool
/// @notice KUB-testnet pooled lending core with indexed interest accrual.
/// @dev Testnet architecture. Audit and economic review required before mainnet use.
contract MaddethPool {
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant YEAR = 365 days;
    uint256 public constant MAX_ORACLE_AGE = 30 minutes;
    uint256 public constant CLOSE_FACTOR_BPS = 5_000;

    struct MarketConfig {
        bool listed;
        bool paused;
        uint16 ltvBps;
        uint16 liquidationThresholdBps;
        uint16 liquidationBonusBps;
        uint16 reserveFactorBps;
        uint128 supplyCap;
        uint128 borrowCap;
        address rateModel;
    }

    struct MarketState {
        uint256 supplyIndex;
        uint256 borrowIndex;
        uint256 lastAccrual;
        uint256 totalSupplyShares;
        uint256 totalBorrowShares;
        uint256 accruedReserves;
    }

    address public owner;
    address public riskAdmin;
    IPriceOracle public oracle;
    bool public protocolPaused;
    bool private entered;

    mapping(address => MarketConfig) public markets;
    mapping(address => MarketState) public marketStates;
    address[] public listedAssets;
    mapping(address => mapping(address => uint256)) private supplyShares;
    mapping(address => mapping(address => uint256)) private borrowShares;
    mapping(address => mapping(address => bool)) public collateralEnabled;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RiskAdminUpdated(address indexed newRiskAdmin);
    event OracleUpdated(address indexed newOracle);
    event ProtocolPaused(bool paused);
    event MarketConfigured(address indexed asset, uint16 ltvBps, uint16 liquidationThresholdBps, uint16 reserveFactorBps, uint128 supplyCap, uint128 borrowCap, address rateModel);
    event MarketPaused(address indexed asset, bool paused);
    event InterestAccrued(address indexed asset, uint256 borrowIndex, uint256 supplyIndex, uint256 interestAccrued, uint256 reservesAccrued);
    event Supplied(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event Borrowed(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event Repaid(address indexed user, address indexed asset, uint256 amount, uint256 shares);
    event CollateralToggled(address indexed user, address indexed asset, bool enabled);
    event Liquidated(address indexed user, address indexed debtAsset, address indexed collateralAsset, uint256 repaid, uint256 seized);
    event BadDebtAbsorbed(address indexed user, address indexed debtAsset, uint256 debtWrittenOff, uint256 reserveCover, uint256 supplierLoss);
    event ReservesWithdrawn(address indexed asset, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyRisk() {
        require(msg.sender == owner || msg.sender == riskAdmin, "NOT_RISK_ADMIN");
        _;
    }

    modifier nonReentrant() {
        require(!entered, "REENTRANCY");
        entered = true;
        _;
        entered = false;
    }

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

    function setProtocolPaused(bool paused) external onlyRisk {
        protocolPaused = paused;
        emit ProtocolPaused(paused);
    }

    function configureMarket(address asset, MarketConfig calldata cfg) external onlyRisk {
        require(asset != address(0), "ZERO_ASSET");
        require(cfg.ltvBps < cfg.liquidationThresholdBps, "LTV_GE_THRESHOLD");
        require(cfg.liquidationThresholdBps < BPS, "BAD_THRESHOLD");
        require(cfg.liquidationBonusBps <= 2_000, "BONUS_TOO_HIGH");
        require(cfg.reserveFactorBps <= 3_000, "RESERVE_TOO_HIGH");
        require(cfg.rateModel != address(0), "ZERO_RATE_MODEL");

        if (markets[asset].listed) {
            _accrue(asset);
        } else {
            listedAssets.push(asset);
            MarketState storage s = marketStates[asset];
            s.supplyIndex = WAD;
            s.borrowIndex = WAD;
            s.lastAccrual = block.timestamp;
        }

        markets[asset] = cfg;
        markets[asset].listed = true;
        emit MarketConfigured(asset, cfg.ltvBps, cfg.liquidationThresholdBps, cfg.reserveFactorBps, cfg.supplyCap, cfg.borrowCap, cfg.rateModel);
    }

    function setPaused(address asset, bool paused) external onlyRisk {
        require(markets[asset].listed, "UNLISTED");
        markets[asset].paused = paused;
        emit MarketPaused(asset, paused);
    }

    function marketCount() external view returns (uint256) {
        return listedAssets.length;
    }

    function accrue(address asset) external {
        require(markets[asset].listed, "UNLISTED");
        _accrue(asset);
    }

    function currentIndexes(address asset) public view returns (uint256 supplyIndex, uint256 borrowIndex) {
        MarketConfig storage m = markets[asset];
        MarketState storage s = marketStates[asset];
        require(m.listed, "UNLISTED");
        supplyIndex = s.supplyIndex;
        borrowIndex = s.borrowIndex;
        uint256 elapsed = block.timestamp - s.lastAccrual;
        if (elapsed == 0 || s.totalBorrowShares == 0) return (supplyIndex, borrowIndex);

        uint256 totalSupply = s.totalSupplyShares * supplyIndex / WAD;
        uint256 totalBorrow = s.totalBorrowShares * borrowIndex / WAD;
        if (totalSupply == 0) return (supplyIndex, borrowIndex);

        uint256 util = totalBorrow >= totalSupply ? WAD : totalBorrow * WAD / totalSupply;
        uint256 annualRate = IInterestRateModel(m.rateModel).borrowRate(util);
        uint256 factor = annualRate * elapsed / YEAR;
        uint256 interest = totalBorrow * factor / WAD;
        uint256 reserveInterest = interest * m.reserveFactorBps / BPS;
        uint256 supplierInterest = interest - reserveInterest;

        borrowIndex = borrowIndex + (borrowIndex * factor / WAD);
        if (s.totalSupplyShares > 0 && supplierInterest > 0) {
            supplyIndex = supplyIndex + (supplierInterest * WAD / s.totalSupplyShares);
        }
    }

    function supplied(address user, address asset) public view returns (uint256) {
        (uint256 index,) = currentIndexes(asset);
        return supplyShares[user][asset] * index / WAD;
    }

    function borrowed(address user, address asset) public view returns (uint256) {
        (, uint256 index) = currentIndexes(asset);
        return borrowShares[user][asset] * index / WAD;
    }

    function rawShares(address user, address asset) external view returns (uint256 suppliedShares_, uint256 borrowedShares_) {
        return (supplyShares[user][asset], borrowShares[user][asset]);
    }

    function marketTotals(address asset)
        public
        view
        returns (uint256 totalSupplied, uint256 totalBorrowed, uint256 utilisation, uint256 reserves)
    {
        MarketState storage s = marketStates[asset];
        (uint256 si, uint256 bi) = currentIndexes(asset);
        totalSupplied = s.totalSupplyShares * si / WAD;
        totalBorrowed = s.totalBorrowShares * bi / WAD;
        utilisation = totalSupplied == 0 ? 0 : (totalBorrowed >= totalSupplied ? WAD : totalBorrowed * WAD / totalSupplied);
        reserves = s.accruedReserves;
        if (s.totalBorrowShares > 0 && block.timestamp > s.lastAccrual) {
            uint256 storedBorrow = s.totalBorrowShares * s.borrowIndex / WAD;
            if (totalBorrowed > storedBorrow) {
                uint256 pendingInterest = totalBorrowed - storedBorrow;
                reserves += pendingInterest * markets[asset].reserveFactorBps / BPS;
            }
        }
    }

    function supply(address asset, uint256 amount) external nonReentrant {
        MarketConfig storage m = markets[asset];
        require(!protocolPaused && m.listed && !m.paused, "MARKET_UNAVAILABLE");
        require(amount > 0, "ZERO_AMOUNT");
        _accrue(asset);
        MarketState storage s = marketStates[asset];
        uint256 totalSupply = s.totalSupplyShares * s.supplyIndex / WAD;
        require(m.supplyCap == 0 || totalSupply + amount <= m.supplyCap, "SUPPLY_CAP");

        _safeTransferFrom(asset, msg.sender, address(this), amount);
        uint256 shares = amount * WAD / s.supplyIndex;
        require(shares > 0, "ZERO_SHARES");
        supplyShares[msg.sender][asset] += shares;
        s.totalSupplyShares += shares;
        emit Supplied(msg.sender, asset, amount, shares);
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
        require(amount > 0, "ZERO_AMOUNT");
        _accrue(asset);
        MarketState storage s = marketStates[asset];
        uint256 userBalance = supplyShares[msg.sender][asset] * s.supplyIndex / WAD;
        require(userBalance >= amount, "BAD_AMOUNT");

        uint256 shares = _divUp(amount * WAD, s.supplyIndex);
        require(shares <= supplyShares[msg.sender][asset], "BAD_SHARES");
        supplyShares[msg.sender][asset] -= shares;
        s.totalSupplyShares -= shares;
        require(_accountHealthy(msg.sender), "WOULD_UNDERCOLLATERALIZE");
        require(IERC20Minimal(asset).balanceOf(address(this)) >= amount, "INSUFFICIENT_LIQUIDITY");
        _safeTransfer(asset, msg.sender, amount);
        emit Withdrawn(msg.sender, asset, amount, shares);
    }

    function borrow(address asset, uint256 amount) external nonReentrant {
        MarketConfig storage m = markets[asset];
        require(!protocolPaused && m.listed && !m.paused, "MARKET_UNAVAILABLE");
        require(amount > 0, "ZERO_AMOUNT");
        _accrue(asset);
        MarketState storage s = marketStates[asset];
        uint256 totalBorrow = s.totalBorrowShares * s.borrowIndex / WAD;
        require(m.borrowCap == 0 || totalBorrow + amount <= m.borrowCap, "BORROW_CAP");
        require(IERC20Minimal(asset).balanceOf(address(this)) >= amount, "INSUFFICIENT_LIQUIDITY");

        uint256 shares = _divUp(amount * WAD, s.borrowIndex);
        borrowShares[msg.sender][asset] += shares;
        s.totalBorrowShares += shares;
        require(_withinBorrowLimit(msg.sender), "LTV_EXCEEDED");
        _safeTransfer(asset, msg.sender, amount);
        emit Borrowed(msg.sender, asset, amount, shares);
    }

    function repay(address asset, uint256 amount) external nonReentrant returns (uint256 paid) {
        return _repayFor(msg.sender, msg.sender, asset, amount);
    }

    function repayFor(address user, address asset, uint256 amount) external nonReentrant returns (uint256 paid) {
        require(user != address(0), "ZERO_USER");
        return _repayFor(msg.sender, user, asset, amount);
    }

    function liquidate(address user, address debtAsset, address collateralAsset, uint256 repayAmount) external nonReentrant {
        require(markets[debtAsset].listed && markets[collateralAsset].listed, "UNLISTED");
        require(repayAmount > 0, "ZERO_AMOUNT");
        _accrue(debtAsset);
        if (collateralAsset != debtAsset) _accrue(collateralAsset);
        require(!_accountHealthy(user), "ACCOUNT_HEALTHY");
        require(collateralEnabled[user][collateralAsset], "NOT_COLLATERAL");

        MarketState storage debtS = marketStates[debtAsset];
        MarketState storage colS = marketStates[collateralAsset];
        uint256 userDebtShares = borrowShares[user][debtAsset];
        uint256 debt = userDebtShares * debtS.borrowIndex / WAD;
        require(debt > 0, "NO_DEBT");

        uint256 paid = _cappedLiquidationRepay(user, debtAsset, collateralAsset, repayAmount, debt);
        uint256 seize = _seizeForRepay(debtAsset, collateralAsset, paid);
        uint256 availableCollateral = supplyShares[user][collateralAsset] * colS.supplyIndex / WAD;
        if (seize > availableCollateral) seize = availableCollateral;
        require(seize > 0, "NO_COLLATERAL");

        uint256 debtSharesToBurn = paid >= debt ? userDebtShares : paid * WAD / debtS.borrowIndex;
        require(debtSharesToBurn > 0, "ZERO_DEBT_SHARES");
        uint256 colSharesToBurn = _divUp(seize * WAD, colS.supplyIndex);
        if (colSharesToBurn > supplyShares[user][collateralAsset]) {
            colSharesToBurn = supplyShares[user][collateralAsset];
        }

        _safeTransferFrom(debtAsset, msg.sender, address(this), paid);
        borrowShares[user][debtAsset] -= debtSharesToBurn;
        debtS.totalBorrowShares -= debtSharesToBurn;
        supplyShares[user][collateralAsset] -= colSharesToBurn;
        colS.totalSupplyShares -= colSharesToBurn;
        _safeTransfer(collateralAsset, msg.sender, seize);
        emit Liquidated(user, debtAsset, collateralAsset, paid, seize);
    }

    /// @notice Writes off unrecoverable debt only after all enabled collateral has been exhausted.
    /// @dev Reserves absorb losses first. Any remainder is socialized to suppliers via the supply index.
    function absorbBadDebt(address user, address debtAsset) external nonReentrant onlyRisk {
        require(markets[debtAsset].listed, "UNLISTED");
        _accrue(debtAsset);
        require(!_accountHealthy(user), "ACCOUNT_HEALTHY");
        (uint256 collateralUsd,,,) = getAccountLiquidity(user);
        require(collateralUsd == 0, "COLLATERAL_REMAINS");

        MarketState storage s = marketStates[debtAsset];
        uint256 userShares = borrowShares[user][debtAsset];
        require(userShares > 0, "NO_DEBT");
        uint256 debt = userShares * s.borrowIndex / WAD;

        uint256 reserveCover = debt > s.accruedReserves ? s.accruedReserves : debt;
        uint256 supplierLoss = debt - reserveCover;
        if (supplierLoss > 0) {
            require(s.totalSupplyShares > 0, "NO_SUPPLIERS");
            uint256 totalSupplied = s.totalSupplyShares * s.supplyIndex / WAD;
            require(supplierLoss < totalSupplied, "MARKET_INSOLVENT");
            uint256 lossPerShare = _divUp(supplierLoss * WAD, s.totalSupplyShares);
            require(lossPerShare < s.supplyIndex, "MARKET_INSOLVENT");
            s.supplyIndex -= lossPerShare;
        }

        s.accruedReserves -= reserveCover;
        borrowShares[user][debtAsset] = 0;
        s.totalBorrowShares -= userShares;
        emit BadDebtAbsorbed(user, debtAsset, debt, reserveCover, supplierLoss);
    }

    function withdrawReserves(address asset, address to, uint256 amount) external nonReentrant onlyOwner {
        require(to != address(0), "ZERO_TO");
        _accrue(asset);
        MarketState storage s = marketStates[asset];
        require(amount <= s.accruedReserves, "RESERVE_BALANCE");
        uint256 cash = IERC20Minimal(asset).balanceOf(address(this));
        uint256 suppliedAssets = s.totalSupplyShares * s.supplyIndex / WAD;
        uint256 borrowedAssets = s.totalBorrowShares * s.borrowIndex / WAD;
        require(cash + borrowedAssets >= suppliedAssets + amount, "RESERVES_NOT_CASHED");
        s.accruedReserves -= amount;
        _safeTransfer(asset, to, amount);
        emit ReservesWithdrawn(asset, to, amount);
    }

    function getAccountLiquidity(address user)
        public
        view
        returns (uint256 collateralUsd, uint256 borrowLimitUsd, uint256 liquidationLimitUsd, uint256 debtUsd)
    {
        uint256 len = listedAssets.length;
        for (uint256 i; i < len; ++i) {
            address asset = listedAssets[i];
            uint256 supplyAmount = supplied(user, asset);
            uint256 debtAmount = borrowed(user, asset);
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
        (,, uint256 liquidationLimitUsd, uint256 debtUsd) = getAccountLiquidity(user);
        if (debtUsd == 0) return type(uint256).max;
        return liquidationLimitUsd * WAD / debtUsd;
    }

    function _repayFor(address payer, address user, address asset, uint256 amount) internal returns (uint256 paid) {
        require(markets[asset].listed, "UNLISTED");
        require(amount > 0, "ZERO_AMOUNT");
        _accrue(asset);
        MarketState storage s = marketStates[asset];
        uint256 userShares = borrowShares[user][asset];
        require(userShares > 0, "NO_DEBT");
        uint256 debt = userShares * s.borrowIndex / WAD;
        paid = amount >= debt ? debt : amount;

        uint256 sharesToBurn = paid == debt ? userShares : paid * WAD / s.borrowIndex;
        require(sharesToBurn > 0, "ZERO_SHARES");
        _safeTransferFrom(asset, payer, address(this), paid);
        borrowShares[user][asset] = userShares - sharesToBurn;
        s.totalBorrowShares -= sharesToBurn;
        emit Repaid(user, asset, paid, sharesToBurn);
    }

    function _cappedLiquidationRepay(
        address user,
        address debtAsset,
        address collateralAsset,
        uint256 requested,
        uint256 debt
    ) internal view returns (uint256 paid) {
        uint256 maxClose = debt * CLOSE_FACTOR_BPS / BPS;
        if (maxClose == 0) maxClose = debt;
        paid = requested > maxClose ? maxClose : requested;

        uint256 availableCollateral = supplied(user, collateralAsset);
        require(availableCollateral > 0, "NO_COLLATERAL");
        (uint256 debtPrice,) = _validPrice(debtAsset);
        (uint256 colPrice,) = _validPrice(collateralAsset);
        uint8 debtDec = IERC20Minimal(debtAsset).decimals();
        uint8 colDec = IERC20Minimal(collateralAsset).decimals();

        uint256 collateralUsd = availableCollateral * colPrice / (10 ** colDec);
        uint256 maxRepayUsd = collateralUsd * BPS / (BPS + markets[collateralAsset].liquidationBonusBps);
        uint256 maxRepayByCollateral = maxRepayUsd * (10 ** debtDec) / debtPrice;
        if (paid > maxRepayByCollateral) paid = maxRepayByCollateral;
        require(paid > 0, "COLLATERAL_DUST");
    }

    function _seizeForRepay(address debtAsset, address collateralAsset, uint256 paid) internal view returns (uint256 seize) {
        (uint256 debtPrice,) = _validPrice(debtAsset);
        (uint256 colPrice,) = _validPrice(collateralAsset);
        uint8 debtDec = IERC20Minimal(debtAsset).decimals();
        uint8 colDec = IERC20Minimal(collateralAsset).decimals();
        uint256 debtUsd = paid * debtPrice / (10 ** debtDec);
        uint256 seizeUsd = debtUsd * (BPS + markets[collateralAsset].liquidationBonusBps) / BPS;
        seize = seizeUsd * (10 ** colDec) / colPrice;
    }

    function _accrue(address asset) internal {
        MarketConfig storage m = markets[asset];
        MarketState storage s = marketStates[asset];
        require(m.listed, "UNLISTED");
        uint256 elapsed = block.timestamp - s.lastAccrual;
        if (elapsed == 0) return;
        if (s.totalBorrowShares == 0 || s.totalSupplyShares == 0) {
            s.lastAccrual = block.timestamp;
            return;
        }

        uint256 totalSupply = s.totalSupplyShares * s.supplyIndex / WAD;
        uint256 totalBorrow = s.totalBorrowShares * s.borrowIndex / WAD;
        uint256 util = totalBorrow >= totalSupply ? WAD : totalBorrow * WAD / totalSupply;
        uint256 annualRate = IInterestRateModel(m.rateModel).borrowRate(util);
        uint256 factor = annualRate * elapsed / YEAR;
        uint256 interest = totalBorrow * factor / WAD;
        uint256 reserveInterest = interest * m.reserveFactorBps / BPS;
        uint256 supplierInterest = interest - reserveInterest;

        s.borrowIndex = s.borrowIndex + (s.borrowIndex * factor / WAD);
        if (supplierInterest > 0) {
            s.supplyIndex = s.supplyIndex + (supplierInterest * WAD / s.totalSupplyShares);
        }
        s.accruedReserves += reserveInterest;
        s.lastAccrual = block.timestamp;
        emit InterestAccrued(asset, s.borrowIndex, s.supplyIndex, interest, reserveInterest);
    }

    function _withinBorrowLimit(address user) internal view returns (bool) {
        (, uint256 borrowLimitUsd,, uint256 debtUsd) = getAccountLiquidity(user);
        return debtUsd <= borrowLimitUsd;
    }

    function _accountHealthy(address user) internal view returns (bool) {
        (,, uint256 liquidationLimitUsd, uint256 debtUsd) = getAccountLiquidity(user);
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

    function _divUp(uint256 x, uint256 y) internal pure returns (uint256) {
        return x == 0 ? 0 : (x - 1) / y + 1;
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
