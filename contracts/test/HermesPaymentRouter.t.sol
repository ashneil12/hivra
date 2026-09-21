// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { HermesPaymentRouter } from "../src/HermesPaymentRouter.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock Hermes Payment Token", "MHPT") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract HermesPaymentRouterTest is Test {
    address internal owner = address(0xA11CE);
    address internal payer = address(0xB0B);
    address internal treasury = address(0xCAFE);
    address internal newTreasury = address(0xD00D);

    HermesPaymentRouter internal router;
    MockToken internal token;

    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event TokenAllowed(address indexed token, bool allowed);
    event PaymentReceived(
        bytes32 indexed quoteId,
        address indexed payer,
        address indexed token,
        uint256 amount,
        address treasury
    );

    function setUp() public {
        router = new HermesPaymentRouter(owner, treasury, false);
        token = new MockToken();
        token.mint(payer, 1_000 ether);

        vm.prank(owner);
        router.setAllowedToken(address(token), true);
    }

    function testConstructorCanStartPaused() public {
        HermesPaymentRouter pausedRouter = new HermesPaymentRouter(owner, treasury, true);
        assertTrue(pausedRouter.paused());
    }

    function testConstructorRejectsZeroTreasury() public {
        vm.expectRevert(HermesPaymentRouter.InvalidTreasury.selector);
        new HermesPaymentRouter(owner, address(0), false);
    }

    function testOwnerCanUpdateTreasury() public {
        vm.expectEmit(true, true, false, true, address(router));
        emit TreasuryUpdated(treasury, newTreasury);

        vm.prank(owner);
        router.setTreasury(newTreasury);

        assertEq(router.treasury(), newTreasury);
    }

    function testRejectsZeroTreasuryUpdate() public {
        vm.prank(owner);
        vm.expectRevert(HermesPaymentRouter.InvalidTreasury.selector);
        router.setTreasury(address(0));
    }

    function testNonOwnerCannotUpdateTreasury() public {
        vm.prank(payer);
        vm.expectRevert();
        router.setTreasury(newTreasury);
    }

    function testOwnerCanAllowAndDisallowToken() public {
        address otherToken = address(0x1234);

        vm.expectEmit(true, false, false, true, address(router));
        emit TokenAllowed(otherToken, true);

        vm.prank(owner);
        router.setAllowedToken(otherToken, true);
        assertTrue(router.allowedToken(otherToken));

        vm.prank(owner);
        router.setAllowedToken(otherToken, false);
        assertFalse(router.allowedToken(otherToken));
    }

    function testNonOwnerCannotSetAllowedToken() public {
        vm.prank(payer);
        vm.expectRevert();
        router.setAllowedToken(address(0xBEEF), true);
    }

    function testRejectsZeroTokenWhenSettingAllowance() public {
        vm.prank(owner);
        vm.expectRevert(HermesPaymentRouter.InvalidToken.selector);
        router.setAllowedToken(address(0), true);
    }

    function testPayRejectsZeroQuoteId() public {
        vm.startPrank(payer);
        token.approve(address(router), 1 ether);
        vm.expectRevert(HermesPaymentRouter.InvalidQuoteId.selector);
        router.pay(bytes32(0), address(token), 1 ether);
        vm.stopPrank();
    }

    function testPayRejectsUnsupportedToken() public {
        MockToken unsupported = new MockToken();
        unsupported.mint(payer, 1 ether);

        vm.startPrank(payer);
        unsupported.approve(address(router), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(HermesPaymentRouter.UnsupportedToken.selector, address(unsupported)));
        router.pay(bytes32("quote-1"), address(unsupported), 1 ether);
        vm.stopPrank();
    }

    function testPayRejectsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(HermesPaymentRouter.InvalidAmount.selector);
        router.pay(bytes32("quote-1"), address(token), 0);
    }

    function testPayTransfersTokensAndEmitsEvent() public {
        bytes32 quoteId = keccak256("managed-venice:quote-1");
        uint256 amount = 25 ether;

        vm.startPrank(payer);
        token.approve(address(router), amount);

        vm.expectEmit(true, true, true, true, address(router));
        emit PaymentReceived(quoteId, payer, address(token), amount, treasury);

        router.pay(quoteId, address(token), amount);
        vm.stopPrank();

        assertEq(token.balanceOf(treasury), amount);
        assertEq(token.balanceOf(payer), 1_000 ether - amount);
    }

    function testOwnerCanPauseAndUnpause() public {
        vm.prank(owner);
        router.pause();
        assertTrue(router.paused());

        vm.prank(owner);
        router.unpause();
        assertFalse(router.paused());
    }

    function testNonOwnerCannotPauseOrUnpause() public {
        vm.prank(payer);
        vm.expectRevert();
        router.pause();

        vm.prank(owner);
        router.pause();

        vm.prank(payer);
        vm.expectRevert();
        router.unpause();
    }

    function testPayRejectsWhilePaused() public {
        vm.prank(owner);
        router.pause();

        vm.startPrank(payer);
        token.approve(address(router), 1 ether);
        vm.expectRevert();
        router.pay(bytes32("quote-1"), address(token), 1 ether);
        vm.stopPrank();
    }
}
