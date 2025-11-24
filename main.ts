import { ethers } from "ethers";
import { Pool, Position } from "@uniswap/v3-sdk";
import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    POOL_ABI,
    ERC20_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    NPM_ABI,
    V3_FACTORY_ADDR,
    SWAP_ROUTER_ADDR,
    CURRENT_CHAIN_ID,
} from "./config";

dotenv.config();

const MAX_UINT128 = (1n << 128n) - 1n;

// ==========================================
// 1. State Management (bot_state.json)
// ==========================================

const STATE_FILE = path.join(__dirname, "bot_state.json");
const SWAP_ROUTER_ABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
];

interface BotState {
    tokenId: string; // indentifier of the NFT (Non-Fungible Token)
    lastCheck: number;
}

function loadState(): BotState {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const data = fs.readFileSync(STATE_FILE, "utf8");
            return JSON.parse(data);
        } catch (e) {
            console.error("[System] Failed to read state file, resetting state.");
        }
    }
    return { tokenId: "0", lastCheck: 0 };
}

async function findOrphanedPosition(wallet: ethers.Wallet): Promise<string> {
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);

    // 1. Ask the contract: "How many NFTs does this wallet own?"
    const balance = await npm.balanceOf(wallet.address);

    if (balance > 0n) {
        // 2. If we own something, get the ID of the last one we received
        // (ERC721Enumerable standard: tokenOfOwnerByIndex)
        // Note: You might need to add "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)" to your ABI
        const lastIndex = balance - 1n;
        const tokenId = await npm.tokenOfOwnerByIndex(wallet.address, lastIndex);

        console.log(`[Recovery] Found orphaned position on-chain: ID ${tokenId}`);
        return tokenId.toString();
    }

    return "0";
}

function saveState(tokenId: string) {
    const state: BotState = { tokenId, lastCheck: Date.now() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[System] State saved: Token ID ${tokenId}`);
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================
// 2. Core Utility Functions
// ==========================================

async function getBalance(token: Token, wallet: ethers.Wallet): Promise<bigint> {
    const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
    return await contract.balanceOf(wallet.address);
}

// Check and Approve
async function checkAndApprove(
    token: Token,
    contract: ethers.Contract,
    spender: string,
    owner: string
) {
    const allowance = await contract.allowance(owner, spender);
    // Simple check: if allowance is 0, approve max，only run when the program run for the first time
    if (allowance === 0n) {
        console.log(`[Approve] Approving ${token.symbol} for ${spender}...`);
        try {
            // todo: eveluate using all the amount or a specficed amount is better
            // give uniswap permission to spend as much of the USDC in the wallet forever
            // note: ethers.MaxUint256 is used for cost-efficiency/lazy concern because everytime we all approve will trigger gas fee, is the industry standard for uiswap
            const tx = await contract.approve(spender, ethers.MaxUint256);
            await tx.wait();
            console.log(`[Approve] ${token.symbol} Approved successfully.`);
        } catch (e) {
            console.error(`[Approve] Failed:`, e);
            throw e;
        }
    }
}

async function approveAll(wallet: ethers.Wallet) {
    const usdc = new ethers.Contract(USDC_TOKEN.address, ERC20_ABI, wallet);
    const weth = new ethers.Contract(WETH_TOKEN.address, ERC20_ABI, wallet);

    // Approve NFT Manager (for Minting)
    await checkAndApprove(USDC_TOKEN, usdc, NONFUNGIBLE_POSITION_MANAGER_ADDR, wallet.address);
    await checkAndApprove(WETH_TOKEN, weth, NONFUNGIBLE_POSITION_MANAGER_ADDR, wallet.address);

    // Approve Swap Router (for Rebalancing)
    await checkAndApprove(USDC_TOKEN, usdc, SWAP_ROUTER_ADDR, wallet.address);
    await checkAndApprove(WETH_TOKEN, weth, SWAP_ROUTER_ADDR, wallet.address);
}

// ==========================================
// 3. Business Logic (Rebalance, Mint)
// ==========================================

async function rebalancePortfolio(wallet: ethers.Wallet, configuredPool: Pool) {
    console.log(`\n[Rebalance] Checking asset balance...`);

    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const valUSDC = Number(ethers.formatUnits(balUSDC, 6));
    const valWETH = Number(ethers.formatUnits(balWETH, 18));

    // Logic to determine price based on which token is Token0
    let priceWethInUsdc: number;
    if (configuredPool.token0.address === WETH_TOKEN.address) {
        priceWethInUsdc = parseFloat(configuredPool.token0Price.toSignificant(6));
    } else {
        priceWethInUsdc = parseFloat(configuredPool.token1Price.toSignificant(6));
    }

    const totalValueUSDC = valUSDC + valWETH * priceWethInUsdc;
    console.log(`   Holding: ${valUSDC.toFixed(2)} USDC + ${valWETH.toFixed(4)} WETH`);
    console.log(`   Total Value: ~$${totalValueUSDC.toFixed(2)} (WETH Price: $${priceWethInUsdc})`);

    const targetValue = totalValueUSDC / 2;
    const usdcDiff = valUSDC - targetValue;

    if (Math.abs(usdcDiff) < 2) {
        console.log(`   [Rebalance] Portfolio is balanced. No action needed.`);
        return;
    }

    const router = new ethers.Contract(SWAP_ROUTER_ADDR, SWAP_ROUTER_ABI, wallet);

    // Define Slippage: 0.5%
    const slippageTolerance = new Percent(50, 10_000);

    if (usdcDiff > 0) {
        // Case: Excess USDC, Sell USDC -> Buy WETH
        const amountInRaw = ethers.parseUnits(usdcDiff.toFixed(6), 6);

        // 1. Create CurrencyAmount for input
        const inputAmount = CurrencyAmount.fromRawAmount(USDC_TOKEN, amountInRaw.toString());

        // 2. Calculate Expected Output using SDK Pool logic
        // getInputAmount/getOutputAmount returns [CurrencyAmount, Pool]
        const [expectedOutput] = await configuredPool.getOutputAmount(inputAmount);

        // 3. Apply Slippage (Expected * (1 - 0.005))
        const minAmountOut = expectedOutput.multiply(new Percent(1).subtract(slippageTolerance));

        console.log(`   [Swap] Selling ${usdcDiff.toFixed(2)} USDC -> WETH`);
        console.log(
            `          Expected: ${expectedOutput.toSignificant(
                6
            )} WETH | Min Acceptable: ${minAmountOut.toSignificant(6)} WETH`
        );

        const tx = await router.exactInputSingle({
            tokenIn: USDC_TOKEN.address,
            tokenOut: WETH_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountInRaw,
            amountOutMinimum: minAmountOut.quotient.toString(), // Protected Value
            sqrtPriceLimitX96: 0,
        });
        await tx.wait();
    } else {
        // Case: Excess WETH, Sell WETH -> Buy USDC
        const wethToSellVal = Math.abs(usdcDiff) / priceWethInUsdc;
        // Use 99% of calculated amount to ensure we have gas if on ETH chain
        const amountInRaw = ethers.parseUnits((wethToSellVal * 0.99).toFixed(18), 18);

        // 1. Create CurrencyAmount
        const inputAmount = CurrencyAmount.fromRawAmount(WETH_TOKEN, amountInRaw.toString());

        // 2. Calculate Expected Output
        const [expectedOutput] = await configuredPool.getOutputAmount(inputAmount);

        // 3. Apply Slippage
        const minAmountOut = expectedOutput.multiply(new Percent(1).subtract(slippageTolerance));

        console.log(`   [Swap] Selling ${wethToSellVal.toFixed(4)} WETH -> USDC`);
        console.log(
            `          Expected: ${expectedOutput.toSignificant(
                6
            )} USDC | Min Acceptable: ${minAmountOut.toSignificant(6)} USDC`
        );

        const tx = await router.exactInputSingle({
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountInRaw,
            amountOutMinimum: minAmountOut.quotient.toString(), // Protected Value
            sqrtPriceLimitX96: 0,
        });
        await tx.wait();
    }
    console.log(`   [Rebalance] Completed.`);
}

async function mintMaxLiquidity(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    tickLower: number,
    tickUpper: number
): Promise<string> {
    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    console.log(
        `\n[Mint] Balance Check: ${ethers.formatUnits(balUSDC, 6)} USDC | ${ethers.formatUnits(
            balWETH,
            18
        )} WETH`
    );

    // Use fromAmounts to calculate max liquidity possible
    // SDK handles sorting internally based on the pool object
    const position = Position.fromAmounts({
        pool: configuredPool,
        tickLower,
        tickUpper,
        amount0: balWETH.toString(), // Note: This assigns value based on SDK logic, not hardcoded Token0
        amount1: balUSDC.toString(),
        useFullPrecision: true,
    });

    // Dynamic Token Order
    // Get the actual Token0 and Token1 from the pool object to prevent mismatches
    const token0Addr = configuredPool.token0.address;
    const token1Addr = configuredPool.token1.address;
    const amount0 = position.mintAmounts.amount0.toString();
    const amount1 = position.mintAmounts.amount1.toString();

    const mintParams = {
        token0: token0Addr, // Use dynamic address
        token1: token1Addr, // Use dynamic address
        fee: POOL_FEE,
        tickLower,
        tickUpper,
        amount0Desired: amount0, // Correct amount for Token0
        amount1Desired: amount1, // Correct amount for Token1
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 120,
    };

    // Debug Logs
    const symbol0 = configuredPool.token0.symbol;
    const symbol1 = configuredPool.token1.symbol;
    const val0 = ethers.formatUnits(amount0, configuredPool.token0.decimals);
    const val1 = ethers.formatUnits(amount1, configuredPool.token1.decimals);

    console.log(`\n[Mint] Minting new position...`);
    console.log(`   Token0 (${symbol0}): ${val0}`);
    console.log(`   Token1 (${symbol1}): ${val1}`);

    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    const tx = await npm.mint(mintParams);
    const receipt = await tx.wait();

    // Parse TokenID from logs
    const event = receipt.logs.find(
        (log: any) =>
            log.topics[0] ===
            ethers.id("Mint(uint256,address,address,uint24,int24,int24,uint128,uint256,uint256)")
    );
    const newTokenId = ethers.AbiCoder.defaultAbiCoder()
        .decode(["uint256"], event.data)[0]
        .toString();

    console.log(`[Mint] Success! Token ID: ${newTokenId}`);
    return newTokenId;
}

// Full Rebalancing Process: Remove Old -> Swap -> Mint New
async function executeFullRebalance(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    oldTokenId: string
) {
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);

    // 1. Burn old position if exists
    if (oldTokenId !== "0") {
        console.log(`\n[Process] Processing old position ${oldTokenId}...`);
        try {
            const pos = await npm.positions(oldTokenId);
            const liquidity = pos.liquidity;
            console.log(`   Current liquity is ${liquidity}`);

            if (liquidity > 0n) {
                // 1. Unbind the liquidity from the pool curve, no longer active liquidity
                // // Money moves to "tokensOwed"
                console.log("   Removing liquidity...");
                const txDec = await npm.decreaseLiquidity({
                    tokenId: oldTokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: Math.floor(Date.now() / 1000) + 120,
                });
                await txDec.wait();
            }

            // 2. EXTRACT the money (Principal + Fees)
            // Money moves to Wallet
            console.log("   Collecting principal and fees...");
            const txCol = await npm.collect({
                tokenId: oldTokenId,
                recipient: wallet.address,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128,
            });
            await txCol.wait(); // Pause the program here until a miner actually puts this transaction into a block and updates the blockchain data

            // 3. Delete the empty NFT
            console.log("   Burning NFT...");
            await npm.burn(oldTokenId);
        } catch (e) {
            console.error(`   [Warning] Failed to process old position (may not exist):`, e);
        }
    }

    // 2. Rebalance (Swap)
    await rebalancePortfolio(wallet, configuredPool);

    // ============================================================
    //  Refresh Price after Swap
    // The price has moved due to our Swap. We must read the new tick
    // before calculating the new range, otherwise we might Mint out-of-range.
    // ============================================================
    console.log("   [System] Refreshing market price after swap...");

    const poolAddr = Pool.getAddress(
        configuredPool.token0,
        configuredPool.token1,
        configuredPool.fee,
        undefined,
        V3_FACTORY_ADDR
    );

    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, wallet);

    const newSlot0 = await poolContract.slot0();
    const newCurrentTick = Number(newSlot0.tick);

    console.log(`   [Update] Price moved from ${configuredPool.tickCurrent} to ${newCurrentTick}`);

    // 3. Calculate new Tick Range using the NEW tick
    const tickSpace = configuredPool.tickSpacing;

    // Widen the range to 2000 or 3000 to prevent immediate out-of-range on volatile networks
    const WIDTH = 2000;

    // Uniswap V3 Hardcoded Limits
    const MIN_TICK = -887272;
    const MAX_TICK = 887272;

    let tickLower = Math.floor((newCurrentTick - WIDTH) / tickSpace) * tickSpace;
    let tickUpper = Math.floor((newCurrentTick + WIDTH) / tickSpace) * tickSpace;

    // Safety Clamp: Ensure ticks stay within physics
    if (tickLower < MIN_TICK) tickLower = Math.ceil(MIN_TICK / tickSpace) * tickSpace;
    if (tickUpper > MAX_TICK) tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;

    // Ensure valid range
    if (tickLower === tickUpper) tickUpper += tickSpace;

    // Double check if upper hit max, move lower down
    if (tickUpper > MAX_TICK) {
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;
        tickLower = tickUpper - tickSpace;
    }

    if (tickLower > tickUpper) [tickLower, tickUpper] = [tickUpper, tickLower];

    console.log(`   New Range: [${tickLower}, ${tickUpper}]`);

    // 4. Mint
    const newTokenId = await mintMaxLiquidity(wallet, configuredPool, tickLower, tickUpper);

    // 5. Save State
    saveState(newTokenId);
}

// ==========================================
// 4. Main Loop
// ==========================================

async function runLifeCycle() {
    console.log("rpc url: ", process.env.RPC_URL);
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

    // Initialize Contracts
    const poolAddr = Pool.getAddress(USDC_TOKEN, WETH_TOKEN, POOL_FEE, undefined, V3_FACTORY_ADDR);
    // 🚨 ADD THIS LINE to see where the bot is looking
    console.log(`[Debug] Checking Pool Address: ${poolAddr} (Fee: ${POOL_FEE})`);

    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);

    console.log(`\n[System] Waking up | Account: ${wallet.address}`);

    // --- 新增自查代码 ---
    const network = await provider.getNetwork();
    console.log(`[Check] Connected to Chain ID: ${network.chainId}`);
    console.log(`[Check] Config expecting Chain ID: ${CURRENT_CHAIN_ID}`);
    // ------------------

    await approveAll(wallet);

    // Read Data
    const [slot0, liquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);
    const configuredPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        slot0.sqrtPriceX96.toString(),
        liquidity.toString(),
        Number(slot0.tick)
    );
    const currentTick = Number(slot0.tick);

    // Display Price
    const price0 = configuredPool.token0Price.toSignificant(6);
    console.log(`   Current Price: 1 WETH = ${price0} USDC | Tick: ${currentTick}`);

    let { tokenId } = loadState();

    // Scenario A: First Run
    if (tokenId === "0") {
        const recoveredId = await findOrphanedPosition(wallet);
        if (recoveredId !== "0") {
            console.log(`[System] RECOVERED STATE! Updated local file to match blockchain.`);
            tokenId = recoveredId;
            saveState(tokenId); // Fix the local file immediately
        }
        console.log(`   [State] No active position found. Initializing...`);
        await executeFullRebalance(wallet, configuredPool, "0");
        return;
    }

    // Scenario B: Check Existing Position
    try {
        const pos = await npm.positions(tokenId);

        // Check if fully withdrawn
        if (pos.liquidity === 0n && pos.tickLower === 0n) {
            console.log(`   [State] Position ${tokenId} is invalid. Re-initializing.`);
            await executeFullRebalance(wallet, configuredPool, "0");
            return;
        }

        const tickLower = Number(pos.tickLower);
        const tickUpper = Number(pos.tickUpper);

        const isOutOfRange = currentTick < tickLower || currentTick > tickUpper;

        if (isOutOfRange) {
            console.log(
                `   [Warning] Out of Range! Current ${currentTick} not in [${tickLower}, ${tickUpper}]`
            );
            console.log(`   >>> Triggering Rebalance Process <<<`);
            await executeFullRebalance(wallet, configuredPool, tokenId);
        } else {
            console.log(`   [State] Running normally. Range: [${tickLower}, ${tickUpper}]`);
            // Print Unclaimed Fees
            const fees0 = ethers.formatUnits(pos.tokensOwed0, 18);
            const fees1 = ethers.formatUnits(pos.tokensOwed1, 6);
            console.log(`   Unclaimed Fees: ${fees0} WETH / ${fees1} USDC`);
        }
    } catch (e) {
        console.error(`   [Error] Failed to read position info:`, e);
    }
}

async function main() {
    while (true) {
        try {
            await runLifeCycle();
        } catch (e) {
            console.error("[Fatal Error] Main loop crash:", e);
        }
        console.log(`[System] Sleeping for 5 minutes...`);
        await sleep(5 * 60 * 1000);
    }
}

main();
