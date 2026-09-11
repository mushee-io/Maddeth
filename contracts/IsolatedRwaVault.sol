// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";

/// @title IsolatedRwaVault
/// @notice One vault = one isolated real-world credit risk domain.
/// @dev Early testnet architecture. Requires issuer/legal/oracle integrations and audit before production.
contract IsolatedRwaVault {
    address public owner;
    address public borrower;
    IERC20Minimal public immutable liquidityAsset;
    uint256 public immutable maturity;
    uint256 public immutable debtCap;
    bool public paused;
    uint256 public totalDeposits;
    uint256 public totalDebt;
    mapping(address => uint256) public deposits;
    mapping(address => bool) public allowlistedLender;

    event Deposited(address indexed lender, uint256 amount);
    event Withdrawn(address indexed lender, uint256 amount);
    event Borrowed(address indexed borrower, uint256 amount);
    event Repaid(uint256 amount);
    event LenderPermission(address indexed lender, bool allowed);

    modifier onlyOwner(){ require(msg.sender == owner, "NOT_OWNER"); _; }
    modifier onlyBorrower(){ require(msg.sender == borrower, "NOT_BORROWER"); _; }

    constructor(address asset, address _borrower, uint256 _maturity, uint256 _debtCap) {
        require(asset != address(0) && _borrower != address(0), "ZERO_ADDRESS");
        require(_maturity > block.timestamp, "BAD_MATURITY");
        owner = msg.sender;
        borrower = _borrower;
        liquidityAsset = IERC20Minimal(asset);
        maturity = _maturity;
        debtCap = _debtCap;
    }

    function setLender(address lender, bool allowed) external onlyOwner { allowlistedLender[lender] = allowed; emit LenderPermission(lender, allowed); }
    function setPaused(bool value) external onlyOwner { paused = value; }

    function deposit(uint256 amount) external {
        require(!paused && allowlistedLender[msg.sender], "NOT_ALLOWED");
        require(amount > 0, "ZERO_AMOUNT");
        require(liquidityAsset.transferFrom(msg.sender, address(this), amount), "TRANSFER_IN");
        deposits[msg.sender] += amount;
        totalDeposits += amount;
        emit Deposited(msg.sender, amount);
    }

    function borrow(uint256 amount) external onlyBorrower {
        require(!paused && block.timestamp < maturity, "VAULT_CLOSED");
        require(totalDebt + amount <= debtCap, "DEBT_CAP");
        require(liquidityAsset.balanceOf(address(this)) >= amount, "NO_LIQUIDITY");
        totalDebt += amount;
        require(liquidityAsset.transfer(borrower, amount), "TRANSFER_OUT");
        emit Borrowed(borrower, amount);
    }

    function repay(uint256 amount) external {
        require(amount > 0 && totalDebt > 0, "NO_DEBT");
        uint256 pay = amount > totalDebt ? totalDebt : amount;
        require(liquidityAsset.transferFrom(msg.sender, address(this), pay), "TRANSFER_IN");
        totalDebt -= pay;
        emit Repaid(pay);
    }

    function withdraw(uint256 amount) external {
        require(block.timestamp >= maturity || totalDebt == 0, "CREDIT_OUTSTANDING");
        require(deposits[msg.sender] >= amount, "BAD_AMOUNT");
        deposits[msg.sender] -= amount;
        totalDeposits -= amount;
        require(liquidityAsset.transfer(msg.sender, amount), "TRANSFER_OUT");
        emit Withdrawn(msg.sender, amount);
    }
}
