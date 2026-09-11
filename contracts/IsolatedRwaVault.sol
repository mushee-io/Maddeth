// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";

/// @title IsolatedRwaVault
/// @notice One vault = one isolated real-world credit risk domain.
/// @dev Testnet architecture. Legal enforcement, servicing and recovery remain off-chain responsibilities.
contract IsolatedRwaVault {
    address public owner;
    address public immutable borrower;
    IERC20Minimal public immutable liquidityAsset;
    uint256 public immutable maturity;
    uint256 public immutable debtCap;

    bool public paused;
    bool public defaulted;
    uint256 public defaultDeclaredAt;
    uint256 public totalDeposits;
    uint256 public totalDebt;
    bool private entered;

    mapping(address => uint256) public deposits;
    mapping(address => bool) public allowlistedLender;

    event Deposited(address indexed lender, uint256 amount);
    event Withdrawn(address indexed lender, uint256 amount);
    event Borrowed(address indexed borrower, uint256 amount);
    event Repaid(address indexed payer, uint256 amount, uint256 debtRemaining);
    event LenderPermission(address indexed lender, bool allowed);
    event PauseUpdated(bool paused);
    event DefaultDeclared(uint256 indexed timestamp, uint256 debtOutstanding);
    event DefaultCured(uint256 indexed timestamp);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

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

    constructor(address asset, address _owner, address _borrower, uint256 _maturity, uint256 _debtCap) {
        require(asset != address(0) && _owner != address(0) && _borrower != address(0), "ZERO_ADDRESS");
        require(_maturity > block.timestamp, "BAD_MATURITY");
        require(_debtCap > 0, "ZERO_DEBT_CAP");
        owner = _owner;
        borrower = _borrower;
        liquidityAsset = IERC20Minimal(asset);
        maturity = _maturity;
        debtCap = _debtCap;
        emit OwnershipTransferred(address(0), _owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
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

    function declareDefault() external onlyOwner {
        require(block.timestamp >= maturity, "NOT_MATURED");
        require(totalDebt > 0, "NO_DEBT");
        require(!defaulted, "ALREADY_DEFAULTED");
        defaulted = true;
        paused = true;
        defaultDeclaredAt = block.timestamp;
        emit DefaultDeclared(block.timestamp, totalDebt);
        emit PauseUpdated(true);
    }

    function deposit(uint256 amount) external nonReentrant {
        require(!paused && !defaulted && allowlistedLender[msg.sender], "NOT_ALLOWED");
        require(block.timestamp < maturity, "VAULT_CLOSED");
        require(amount > 0, "ZERO_AMOUNT");

        _safeTransferFrom(address(liquidityAsset), msg.sender, address(this), amount);
        deposits[msg.sender] += amount;
        totalDeposits += amount;
        emit Deposited(msg.sender, amount);
    }

    function borrow(uint256 amount) external onlyBorrower nonReentrant {
        require(!paused && !defaulted && block.timestamp < maturity, "VAULT_CLOSED");
        require(amount > 0, "ZERO_AMOUNT");
        require(totalDebt + amount <= debtCap, "DEBT_CAP");
        require(liquidityAsset.balanceOf(address(this)) >= amount, "NO_LIQUIDITY");

        totalDebt += amount;
        _safeTransfer(address(liquidityAsset), borrower, amount);
        emit Borrowed(borrower, amount);
    }

    function repay(uint256 amount) external nonReentrant returns (uint256 paid) {
        require(amount > 0 && totalDebt > 0, "NO_DEBT");
        paid = amount > totalDebt ? totalDebt : amount;

        _safeTransferFrom(address(liquidityAsset), msg.sender, address(this), paid);
        totalDebt -= paid;
        emit Repaid(msg.sender, paid, totalDebt);

        if (defaulted && totalDebt == 0) {
            defaulted = false;
            defaultDeclaredAt = 0;
            emit DefaultCured(block.timestamp);
        }
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "ZERO_AMOUNT");
        require(totalDebt == 0, "CREDIT_OUTSTANDING");
        require(deposits[msg.sender] >= amount, "BAD_AMOUNT");
        require(liquidityAsset.balanceOf(address(this)) >= amount, "NO_LIQUIDITY");

        deposits[msg.sender] -= amount;
        totalDeposits -= amount;
        _safeTransfer(address(liquidityAsset), msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function status() external view returns (string memory) {
        if (defaulted) return "DEFAULTED";
        if (totalDebt == 0 && block.timestamp >= maturity) return "MATURED_REPAID";
        if (block.timestamp >= maturity) return "MATURED_OUTSTANDING";
        if (paused) return "PAUSED";
        return "ACTIVE";
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
