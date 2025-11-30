import { ethers, NonceManager } from "ethers";
import { Pool, Position } from "@uniswap/v3-sdk";
import * as dotenv from "dotenv";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    POOL_ABI,
    NPM_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    V3_FACTORY_ADDR,
} from "./config";

import { loadState, scanLocalOrphans } from "./src/state"; // [Added] scanLocalOrphans
import { approveAll, executeFullRebalance } from "./src/actions";
import { AaveManager } from "./src/hedge";
import { RobustProvider } from "./src/connection";
import { sendEmailAlert } from "./src/utils";

dotenv.config();

const HEDGE_CHECK_INTERVAL_MS = 60 * 1000; 

let wallet: ethers.Wallet;
let provider: ethers.Provider;
let robustProvider: RobustProvider;
let npm: ethers.Contract;
let poolContract: ethers.Contract;
let aave: AaveManager;

let isProcessing = false; 
let lastHedgeTime = 0; 

// Safe Mode Flag
let isSafeMode = false;

async function initialize() {
    const rpcUrl = process.env.RPC_URL || "";

    robustProvider = new RobustProvider(rpcUrl, async () => {
        console.log("[System] Reconnected. Re-binding events...");
        await setupEventListeners();
    });

    provider = robustProvider.getProvider();
    const baseWallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    
    const managedWallet = new NonceManager(baseWallet);
    (managedWallet as any).address = baseWallet.address;

    wallet = managedWallet as any;
    console.log(`[System] Wallet initialized: ${await wallet.getAddress()}`);
    
    const poolAddr = Pool.getAddress(USDC_TOKEN, WETH_TOKEN, POOL_FEE, undefined, V3_FACTORY_ADDR);
    poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
    npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    aave = new AaveManager(wallet);

    console.log(`[System] Initialized.`);

    await approveAll(wallet);

    // Orphan Position Scanning
    // If local state is 0 but on-chain position exists, sync state.
    const state = loadState();
    if (state.tokenId === "0") {
        await scanLocalOrphans(wallet);
    }

    await setupEventListeners();
}

async function setupEventListeners() {
    provider.removeAllListeners();
    console.log("[System] Listening for blocks...");

    provider.on("block", async (blockNumber) => {
        // Safe Mode Check
        if (isSafeMode) {
            if (blockNumber % 100 === 0) { // Reduce log noise
                console.warn(`[SafeMode] Bot is in SAFE MODE. No actions taken. Block: ${blockNumber}`);
            }
            return;
        }

        if (isProcessing) return;
        isProcessing = true;

        try {
            await onNewBlock(blockNumber);
        } catch (e) {
            console.error(`[Block ${blockNumber}] Error:`, e);
        } finally {
            isProcessing = false;
        }
    });
}

async function onNewBlock(blockNumber: number) {
    const { tokenId } = await loadState();

    if (!tokenId || tokenId === "0") {
        console.log(`[Block ${blockNumber}] No active position. Initializing Strategy...`);

        // ... Fetch Pool Data ...
        const [slot0, liquidity] = await Promise.all([
            poolContract.slot0(),
            poolContract.liquidity(),
        ]);

        const configuredPool = new Pool(
            USDC_TOKEN,
            WETH_TOKEN,
            POOL_FEE,
            slot0.sqrtPriceX96.toString(),
            liquidity.toString(),
            Number(slot0.tick)
        );

        // If executeFullRebalance throws (e.g. TWAP check failed), catch it here
        // protects app from crashing, waits for next block retry.
        await executeFullRebalance(wallet, configuredPool, "0");

        lastHedgeTime = 0;
        return;
    }

    // ============================================================
    // CRITICAL PATH: SAFETY CHECK
    // ============================================================
    //  If check returns false, enter Safe Mode
    const isSafe = await aave.checkHealthAndPanic(tokenId);

    if (!isSafe) {
        console.error("[System] Panic exit triggered. Entering SAFE MODE.");
        await sendEmailAlert("Bot Stopped", "Entered SAFE MODE after panic exit.");
        isSafeMode = true; // Lock status, stop all operations
        return;
    }

    // ============================================================
    // STRATEGY PATH
    // ============================================================

    const now = Date.now();
    if (now - lastHedgeTime < HEDGE_CHECK_INTERVAL_MS) {
        return;
    }

    console.log(`[Block ${blockNumber}] Running Strategy Logic...`);

    const [slot0, liquidity] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
    ]);

    const currentTick = Number(slot0.tick);
    const configuredPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        slot0.sqrtPriceX96.toString(),
        liquidity.toString(),
        currentTick
    );

    const pos = await npm.positions(tokenId);
    if (pos.liquidity === 0n) {
        await sendEmailAlert("CRITICAL: Position Closed.", `ID: ${tokenId}`);
        // Mark as orphan or reset
        await scanLocalOrphans(wallet); 
        return null;
    }

    const tl = Number(pos.tickLower);
    const tu = Number(pos.tickUpper);

    if (currentTick < tl || currentTick > tu) {
        console.log(`[Strategy] Out of Range. Rebalancing...`);    
        await executeFullRebalance(wallet, configuredPool, tokenId);
        lastHedgeTime = Date.now(); 
        return;
    }

    // Check Hedge
    const positionSDK = new Position({
        pool: configuredPool,
        liquidity: pos.liquidity.toString(),
        tickLower: tl,
        tickUpper: tu,
    });

    const amount0 = BigInt(positionSDK.amount0.quotient.toString());
    const amount1 = BigInt(positionSDK.amount1.quotient.toString());

    const lpEthAmount =
        WETH_TOKEN.address.toLowerCase() < USDC_TOKEN.address.toLowerCase()
            ? amount0
            : amount1;

    await aave.adjustHedge(lpEthAmount, tokenId);

    lastHedgeTime = Date.now();
}

initialize().catch(console.error);