// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "openzeppelin-contracts/contracts/access/Ownable.sol";
import { Pausable } from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title HermesPaymentRouter
/// @notice Minimal quote-linked ERC20 payment rail for HermesOS connected-wallet top-ups.
/// @dev Business logic stays off-chain: quote pricing, expiry, ledger allocation, and
///      payment type are verified by dashboard reconciliation against PaymentReceived events.
contract HermesPaymentRouter is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public treasury;
    mapping(address token => bool allowed) public allowedToken;

    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event TokenAllowed(address indexed token, bool allowed);
    event PaymentReceived(
        bytes32 indexed quoteId,
        address indexed payer,
        address indexed token,
        uint256 amount,
        address treasury
    );

    error InvalidTreasury();
    error InvalidToken();
    error UnsupportedToken(address token);
    error InvalidAmount();
    error InvalidQuoteId();

    constructor(address initialOwner, address initialTreasury, bool startPaused) Ownable(initialOwner) {
        if (initialTreasury == address(0)) revert InvalidTreasury();
        treasury = initialTreasury;
        if (startPaused) _pause();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert InvalidToken();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function pay(bytes32 quoteId, address token, uint256 amount) external nonReentrant whenNotPaused {
        if (quoteId == bytes32(0)) revert InvalidQuoteId();
        if (!allowedToken[token]) revert UnsupportedToken(token);
        if (amount == 0) revert InvalidAmount();

        IERC20(token).safeTransferFrom(msg.sender, treasury, amount);
        emit PaymentReceived(quoteId, msg.sender, token, amount, treasury);
    }
}
