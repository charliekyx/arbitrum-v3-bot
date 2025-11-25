import { ethers } from "ethers";
import { Pool } from "@uniswap/v3-sdk";
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
import { sleep, withRetry } from "./src/utils";
import { loadState, saveState } from "./src/state";
import {
    approveAll,
    atomicExitPosition,
    rebalancePortfolio,
    mintMaxLiquidity,
    executeFullRebalance,
} from "./src/actions";

dotenv.config();

// ==========================================
// Main Logic
// ==========================================

async function runLifeCycle() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

    const poolAddr = Pool.getAddress(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        undefined,
        V3_FACTORY_ADDR
    );
    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const npm = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        NPM_ABI,
        wallet
    );

    console.log(`\n[System] Cycle Start | ${new Date().toISOString()}`);

    await approveAll(wallet);

    const [slot0, liquidity] = await withRetry(() =>
        Promise.all([poolContract.slot0(), poolContract.liquidity()])
    );

    const configuredPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        slot0.sqrtPriceX96.toString(),
        liquidity.toString(),
        Number(slot0.tick)
    );
    const currentTick = Number(slot0.tick);

    const price =
        configuredPool.token0.address === WETH_TOKEN.address
            ? configuredPool.token0Price.toSignificant(6)
            : configuredPool.token1Price.toSignificant(6);

    console.log(`   Price: 1 WETH = ${price} USDC | Tick: ${currentTick}`);

    let { tokenId } = loadState();

    // Branch A: Create new Position
    if (tokenId === "0") {
        console.log(`   [Action] No position. Starting fresh.`);
        await executeFullRebalance(wallet, configuredPool, "0");
        return;
    }

    // Branch B: Manage Existing Position
    try {
        const pos = await withRetry(() => npm.positions(tokenId));

        if (pos.liquidity === 0n && pos.tickLower === 0n) {
            console.warn(
                `   [Warning] Position ${tokenId} is dead. Resetting.`
            );
            saveState("0");
            return;
        }

        const tl = Number(pos.tickLower);
        const tu = Number(pos.tickUpper);

        if (currentTick < tl || currentTick > tu) {
            if (currentTick < tl || currentTick > tu) {
                console.log(
                    `   [Action] Out of Range! (${tl} < ${currentTick} < ${tu})`
                );
                // Trigger the full atomic rebalance workflow
                await executeFullRebalance(wallet, configuredPool, tokenId);
            } else {
                console.log(`   [Status] In Range.`);
            }
        }
    } catch (e) {
        console.error(`   [Error] Cycle failed:`, e);
    }
}

async function main() {
    while (true) {
        try {
            await runLifeCycle();
        } catch (e) {
            console.error("[Fatal] Main loop error:", e);
            // Prevent infinite rapid loops if RPC is down
            await sleep(10000);
        }
        console.log(`[System] Sleeping 5 min...`);
        await sleep(5 * 60 * 1000);
    }
}

main();
