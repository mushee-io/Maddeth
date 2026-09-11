// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {Ownable2Step} from "./utils/Ownable2Step.sol";

/// @title IsolatedRwaVault
/// @notice One vault = one isolated real-world credit risk domain.
/// @dev Testnet architecture. Legal enforcement, servicing and recovery remain off-chain responsibilities.
contract IsolatedRwaVault is Ownable2Step {
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;

    address public immutable borrower;
    IERC20Minimal public immutable liquidityAsset;
    uint256 public immutable maturity;
    uint256 public immutable debtCap;

    bool public paused;
    bool public defaulted;
    uint256 public defaultDeclaredAt;
    uint16 public fixedAprBps;
    uint256 public principalOutstanding;
    uint256 public totalShares;
    uint256 private storedDebt;
    uint256 private storedLastAccrual;
    bool private entered;

    mapping(address => uint256) public lenderShares;
    mapping(address => bool) public allowlistedLender;

    event Deposited(address indexed lender, uint256 amount, uint256 shares);
    event Withdrawn(address indexed lender, uint256 amount, uint256 shares);
    event Borrowed(address indexed borrower, uint256 amount);
    event Repaid(address indexed payer, uint256 amount, uint256 debtRemaining, uint256 principalRemaining);
    event InterestAccrued(uint256 interest, uint256 debtAfter, uint256 timestamp);
    event FixedAprUpdated(uint16 aprBps);
    event LenderPermission(address indexed lender, bool allowed);
    event PauseUpdated(bool paused);
    event DefaultDeclared(uint256 indexed timestamp, uint256 debtOutstanding);
    event DefaultCured(uint256 indexed timestamp);

    modifier onlyBorrower() {
        require(msg.sender == borrower, "NOT_BORROWER");
        _;
    }

    modifier nonReentrant() {
        require(!entered, "REENTRANCY");
        entered = true;
        _;
        entered = false;
    }

    constructor(address asset, address _owner, address _borrower, uint256 _maturity, uint256 _debtCap)
        Ownable2Step(_owner)
    {
        require(asset != address(0) && asset.code.length > 0 && _borrower != address(0), "BAD_ADDRESS");
        require(IERC20Minimal(asset).decimals() <= 36, "BAD_ASSET_DECIMALS");
        require(_maturity > block.timestamp, "BAD_MATURITY");
        require(_debtCap > 0, "ZERO_DEBT_CAP");
        borrower = _borrower;
        liquidityAsset = IERC20Minimal(asset);
        maturity = _maturity;
        debtCap = _debtCap;
        storedLastAccrual = block.timestamp;
    }

    /// @notice Sets a fixed annual borrower APR for this isolated vault.
    /// @dev Terms are immutable after first deposit/borrow activity to prevent repricing lenders after funding.
    function setFixedAprBps(uint16 aprBps) external onlyOwner {
        require(totalShares == 0 && principalOutstanding == 0 && storedDebt == 0, "TERMS_LOCKED");
        require(aprBps <= 5_000, "APR_TOO_HIGH");
        fixedAprBps = aprBps;
        emit FixedAprUpdated(aprBps);
    }

    function setLender(address lender, bool allowed) external onlyOwner {
        require(lender != address(0), "ZERO_LENDER");
        allowlistedLender[lender] = allowed;
        emit LenderPermission(lender, allowed);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseUpdated(value);
    }

    function accrue() external {
        _accrue();
    }

    function lastAccrual() external view returns (uint256) {
        return storedLastAccrual;
    }

    function totalDebt() public view returns (uint256) {
        return _currentDebt();
    }

    /// @notice Cash plus borrower receivable. This is the accounting NAV for lender shares.
    function totalAssets() public view returns (uint256) {
        return liquidityAsset.balanceOf(address(this)) + _currentDebt();
    }

    /// @notice Backwards-compatible vault deposit metric, now including accrued lender yield.
    function totalDeposits() external view returns (uint256) {
        return totalShares == 0 ? 0 : totalAssets();
    }

    /// @notice Current claim of one lender, including accrued interest receivable.
    function deposits(address lender) public view returns (uint256) {
        if (totalShares == 0) return 0;
        return lenderShares[lender] * totalAssets() / totalShares;
    }

    function maxWithdraw(address lender) external view returns (uint256) {
        if (_currentDebt() != 0) return 0;
        return deposits(lender);
    }

    function declareDefault() external onlyOwner {
        require(block.timestamp >= maturity, "NOT_MATURED");
        _accrue();
        require(storedDebt > 0, "NO_DEBT");
        require(!defaulted, "ALREADY_DEFAULTED");
        defaulted = true;
        paused = true;
        defaultDeclaredAt = block.timestamp;
        emit DefaultDeclared(block.timestamp, storedDebt);
        emit PauseUpdated(true);
    }

    function deposit(uint256 amount) external nonReentrant {
        require(!paused && !defaulted && allowlistedLender[msg.sender], "NOT_ALLOWED");
        require(block.timestamp < maturity, "VAULT_CLOSED");
        require(amount > 0, "ZERO_AMOUNT");

        _accrue();
        uint256 assetsBefore = totalAssets();
        uint256 shares = totalShares == 0 ? amount : amount * totalShares / assetsBefore;
        require(shares > 0, "ZERO_SHARES");

        _safeTransferFromExact(msg.sender, amount);
        lenderShares[msg.sender] += shares;
        totalShares += shares;
        emit Deposited(msg.sender, amount, shares);
    }

    function borrow(uint256 amount) external onlyBorrower nonReentrant {
        require(!paused && !defaulted && block.timestamp < maturity, "VAULT_CLOSED");
        require(amount > 0, "ZERO_AMOUNT");
        _accrue();
        require(principalOutstanding + amount <= debtCap, "DEBT_CAP");
        require(liquidityAsset.balanceOf(address(this)) >= amount, "NO_LIQUIDITY");

        principalOutstanding += amount;
        storedDebt += amount;
        _safeTransferExact(borrower, amount);
        emit Borrowed(borrower, amount);
    }

    function repay(uint256 amount) external nonReentrant returns (uint256 paid) {
        require(amount > 0, "ZERO_AMOUNT");
        _accrue();
        require(storedDebt > 0, "NO_DEBT");
        paid = amount > storedDebt ? storedDebt : amount;

        _safeTransferFromExact(msg.sender, paid);
        uint256 interestDue = storedDebt > principalOutstanding ? storedDebt - principalOutstanding : 0;
        uint256 principalReduction = paid > interestDue ? paid - interestDue : 0;
        if (principalReduction > principalOutstanding) principalReduction = principalOutstanding;
        principalOutstanding -= principalReduction;
        storedDebt -= paid;
        emit Repaid(msg.sender, paid, storedDebt, principalOutstanding);

        if (defaulted && storedDebt == 0) {
            defaulted = false;
            defaultDeclaredAt = 0;
            emit DefaultCured(block.timestamp);
        }
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "ZERO_AMOUNT");
        _accrue();
        require(storedDebt == 0, "CREDIT_OUTSTANDING");
        require(totalShares > 0, "NO_SHARES");

        uint256 assetsBefore = liquidityAsset.balanceOf(address(this));
        require(assetsBefore > 0, "NO_LIQUIDITY");
        uint256 shares = _divUp(amount * totalShares, assetsBefore);
        require(lenderShares[msg.sender] >= shares, "BAD_AMOUNT");
        require(assetsBefore >= amount, "NO_LIQUIDITY");

        lenderShares[msg.sender] -= shares;
        totalShares -= shares;
        _safeTransferExact(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shares);
    }

    function status() external view returns (string memory) {
        uint256 debt = _currentDebt();
        if (defaulted) return "DEFAULTED";
        if (debt == 0 && block.timestamp >= maturity) return "MATURED_REPAID";
        if (block.timestamp >= maturity) return "MATURED_OUTSTANDING";
        if (paused) return "PAUSED";
        return "ACTIVE";
    }

    function _currentDebt() internal view returns (uint256 debt) {
        debt = storedDebt;
        if (debt == 0 || fixedAprBps == 0 || block.timestamp <= storedLastAccrual) return debt;
        uint256 elapsed = block.timestamp - storedLastAccrual;
        uint256 interest = debt * fixedAprBps * elapsed / BPS / YEAR;
        return debt + interest;
    }

    function _accrue() internal {
        if (block.timestamp <= storedLastAccrual) return;
        if (storedDebt == 0 || fixedAprBps == 0) {
            storedLastAccrual = block.timestamp;
            return;
        }
        uint256 elapsed = block.timestamp - storedLastAccrual;
        uint256 interest = storedDebt * fixedAprBps * elapsed / BPS / YEAR;
        storedDebt += interest;
        storedLastAccrual = block.timestamp;
        if (interest > 0) emit InterestAccrued(interest, storedDebt, block.timestamp);
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

    function _safeTransferFromExact(address from, uint256 amount) internal {
        address token = address(liquidityAsset);
        uint256 beforeBalance = liquidityAsset.balanceOf(address(this));
        _safeTransferFrom(token, from, address(this), amount);
        uint256 afterBalance = liquidityAsset.balanceOf(address(this));
        require(afterBalance >= beforeBalance && afterBalance - beforeBalance == amount, "UNSUPPORTED_TOKEN_BEHAVIOR");
    }

    function _safeTransferExact(address to, uint256 amount) internal {
        address token = address(liquidityAsset);
        uint256 vaultBefore = liquidityAsset.balanceOf(address(this));
        uint256 recipientBefore = liquidityAsset.balanceOf(to);
        _safeTransfer(token, to, amount);
        uint256 vaultAfter = liquidityAsset.balanceOf(address(this));
        uint256 recipientAfter = liquidityAsset.balanceOf(to);
        require(vaultBefore >= vaultAfter && vaultBefore - vaultAfter == amount, "UNSUPPORTED_TOKEN_BEHAVIOR");
        require(recipientAfter >= recipientBefore && recipientAfter - recipientBefore == amount, "UNSUPPORTED_TOKEN_BEHAVIOR");
    }
}
