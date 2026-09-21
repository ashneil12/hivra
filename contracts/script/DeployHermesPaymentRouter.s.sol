// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { HermesPaymentRouter } from "../src/HermesPaymentRouter.sol";

contract DeployHermesPaymentRouter is Script {
    function run() external returns (HermesPaymentRouter router) {
        uint256 deployerPrivateKey = vm.envUint("PAYMENT_ROUTER_DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("PAYMENT_ROUTER_OWNER");
        address treasury = vm.envAddress("PAYMENT_ROUTER_TREASURY");

        bool startPaused = vm.envOr("PAYMENT_ROUTER_START_PAUSED", true);

        if (block.chainid != 8453) revert("HermesPaymentRouter: Base mainnet only");

        vm.startBroadcast(deployerPrivateKey);
        router = new HermesPaymentRouter(owner, treasury, startPaused);
        vm.stopBroadcast();
    }
}
