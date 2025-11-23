import { ethers } from 'ethers';
import { Pool, Position } from '@uniswap/v3-sdk';
import { Token } from '@uniswap/sdk-core';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

import { 
    USDC_TOKEN, WETH_TOKEN, POOL_FEE, POOL_ABI, ERC20_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, V3_FACTORY_ADDR, SWAP_ROUTER_ADDR,
    CURRENT_CHAIN_ID
} from './config';

dotenv.config();

// ==========================================
// 1. State Management (bot_state.json)
// ==========================================

const STATE_FILE = path.join(__dirname, 'bot_state.json');
const SWAP_ROUTER_ABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

interface BotState {
    tokenId: string; // indentifier of the NFT (Non-Fungible Token)
    lastCheck: number;
}

function loadState(): BotState {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
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

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ==========================================
// 2. Core Utility Functions
// ==========================================

async function getBalance(token: Token, wallet: ethers.Wallet): Promise<bigint> {
    const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
    return await contract.balanceOf(wallet.address);
}

// Check and Approve
async function checkAndApprove(token: Token, contract: ethers.Contract, spender: string, owner: string) {
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

// Rebalance Portfolio: Sell excess asset to reach approx 50/50 value
async function rebalancePortfolio(wallet: ethers.Wallet, configuredPool: Pool) {
    console.log(`\n[Rebalance] Checking asset balance...`);

    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const valUSDC = Number(ethers.formatUnits(balUSDC, 6));
    const valWETH = Number(ethers.formatUnits(balWETH, 18));
    
    // Calculate total value in terms of USDC
    // Token0 (WETH) price in terms of Token1 (USDC)
    const priceWETH = parseFloat(configuredPool.token0Price.toSignificant(6));
    const totalValueUSDC = valUSDC + (valWETH * priceWETH);
    
    console.log(`   Holding: ${valUSDC.toFixed(2)} USDC + ${valWETH.toFixed(4)} WETH`);
    console.log(`   Total Value: ~$${totalValueUSDC.toFixed(2)} (WETH Price: $${priceWETH})`);

    const targetValue = totalValueUSDC / 2;
    const usdcDiff = valUSDC - targetValue; // Positive = Excess USDC, Negative = Excess WETH
    
    // Threshold: Deviation less than 2 USD, do not swap (Adjustable for testnet)
    if (Math.abs(usdcDiff) < 2) {
        console.log(`   [Rebalance] Portfolio is balanced. No action needed.`);
        return;
    }

    const router = new ethers.Contract(SWAP_ROUTER_ADDR, SWAP_ROUTER_ABI, wallet);
    
    if (usdcDiff > 0) {
        // Excess USDC: Sell USDC -> Buy WETH
        const amountToSell = ethers.parseUnits(usdcDiff.toFixed(6), 6);
        console.log(`   [Swap] Selling ${usdcDiff.toFixed(2)} USDC -> WETH`);
        
        const tx = await router.exactInputSingle({
            tokenIn: USDC_TOKEN.address,
            tokenOut: WETH_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountToSell,
            amountOutMinimum: 0, 
            sqrtPriceLimitX96: 0
        });
        await tx.wait();

    } else {
        // Excess WETH: Sell WETH -> Buy USDC
        const wethToSellVal = Math.abs(usdcDiff) / priceWETH;
        // Leave a small buffer for Gas if using ETH chain
        const amountToSell = ethers.parseUnits((wethToSellVal * 0.99).toFixed(18), 18);
        console.log(`   [Swap] Selling ${wethToSellVal.toFixed(4)} WETH -> USDC`);

        const tx = await router.exactInputSingle({
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountToSell,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });
        await tx.wait();
    }
    console.log(`   [Rebalance] Completed.`);
}

// Mint New Position using all available funds
async function mintMaxLiquidity(wallet: ethers.Wallet, configuredPool: Pool, tickLower: number, tickUpper: number): Promise<string> {
    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    // Use fromAmounts to calculate max liquidity possible
    const position = Position.fromAmounts({
        pool: configuredPool,
        tickLower,
        tickUpper,
        amount0: balWETH.toString(), 
        amount1: balUSDC.toString(), 
        useFullPrecision: true
    });

    const mintParams = {
        token0: WETH_TOKEN.address,
        token1: USDC_TOKEN.address,
        fee: POOL_FEE,
        tickLower,
        tickUpper,
        amount0Desired: position.mintAmounts.amount0.toString(),
        amount1Desired: position.mintAmounts.amount1.toString(),
        amount0Min: 0, // In production, suggest setting 0.5% slippage
        amount1Min: 0,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 120
    };

    console.log(`\n[Mint] Minting new position...`);
    console.log(`   Input: ${ethers.formatUnits(mintParams.amount1Desired, 6)} USDC + ${ethers.formatUnits(mintParams.amount0Desired, 18)} WETH`);

    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    const tx = await npm.mint(mintParams);
    const receipt = await tx.wait();

    // Parse TokenID from logs
    const event = receipt.logs.find((log: any) => log.topics[0] === ethers.id('Mint(uint256,address,address,uint24,int24,int24,uint128,uint256,uint256)'));
    const newTokenId = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], event.data)[0].toString();
    
    console.log(`[Mint] Success! Token ID: ${newTokenId}`);
    return newTokenId;
}

// Full Rebalancing Process: Remove Old -> Swap -> Mint New
async function executeFullRebalance(wallet: ethers.Wallet, configuredPool: Pool, oldTokenId: string) {
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);

    // 1. Burn old position if exists
    if (oldTokenId !== "0") {
        console.log(`\n[Process] Processing old position ${oldTokenId}...`);
        try {
            const pos = await npm.positions(oldTokenId);
            const liquidity = pos.liquidity;
            console.log(`   Current liquity is ${liquidity}`)
            
            if (liquidity > 0n) {
              // 1. Unbind the liquidity from the pool curve, no longer active liquidity
              // // Money moves to "tokensOwed"
                console.log("   Removing liquidity...");
                const txDec = await npm.decreaseLiquidity({
                    tokenId: oldTokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: Math.floor(Date.now() / 1000) + 120
                });
                await txDec.wait();
            }

            // 2. EXTRACT the money (Principal + Fees)
            // Money moves to Wallet
            console.log("   Collecting principal and fees...");
            const txCol = await npm.collect({
                tokenId: oldTokenId,
                recipient: wallet.address,
                amount0Max: ethers.MaxUint256,
                amount1Max: ethers.MaxUint256
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

    // 3. Calculate new Tick Range (+/- 1000 ticks)
    const currentTick = configuredPool.tickCurrent;
    const tickSpace = configuredPool.tickSpacing;
    const WIDTH = 1000;
    
    let tickLower = Math.floor((currentTick - WIDTH) / tickSpace) * tickSpace;
    let tickUpper = Math.floor((currentTick + WIDTH) / tickSpace) * tickSpace;
    if (tickLower === tickUpper) tickUpper += tickSpace;
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
  console.log("rpc url: ", process.env.RPC_URL)
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
        USDC_TOKEN, WETH_TOKEN, POOL_FEE, slot0.sqrtPriceX96.toString(), liquidity.toString(), Number(slot0.tick)
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
            console.log(`   [Warning] Out of Range! Current ${currentTick} not in [${tickLower}, ${tickUpper}]`);
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