import { ethers } from "ethers";
import { Pool, Position } from "@uniswap/v3-sdk";
import { Token, CurrencyAmount } from "@uniswap/sdk-core";
import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    ERC20_ABI,
    NPM_ABI,
    SWAP_ROUTER_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    SWAP_ROUTER_ADDR,
    MAX_UINT128,
    SLIPPAGE_TOLERANCE,
    TX_TIMEOUT_MS,
} from "../config";
import { withRetry, waitWithTimeout } from "./utils";

// --- Wallet Utilities ---
export async function getBalance(token: Token, wallet: ethers.Wallet): Promise<bigint> {
    const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
    return await withRetry(() => contract.balanceOf(wallet.address));
}

export async function approveAll(wallet: ethers.Wallet) {
    const tokens = [USDC_TOKEN, WETH_TOKEN];
    const spenders = [NONFUNGIBLE_POSITION_MANAGER_ADDR, SWAP_ROUTER_ADDR];

    for (const token of tokens) {
        const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
        for (const spender of spenders) {
            const allowance = await withRetry(() => contract.allowance(wallet.address, spender));
            if (allowance === 0n) {
                console.log(`[Approve] Authorizing ${token.symbol} for ${spender}...`);
                const tx = await contract.approve(spender, ethers.MaxUint256);
                await waitWithTimeout(tx, TX_TIMEOUT_MS);
                console.log(`[Approve] Success.`);
            }
        }
    }
}

// --- Core Actions ---
export async function atomicExitPosition(wallet: ethers.Wallet, tokenId: string) {
    console.log(`\n[Exit] Executing Atomic Exit for Token ${tokenId}...`);
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);

    const pos = await withRetry(() => npm.positions(tokenId));
    const liquidity = pos.liquidity;

    const calls: string[] = [];
    const iface = npm.interface;

    // 1. Decrease Liquidity
    if (liquidity > 0n) {
        const decreaseData = {
            tokenId: tokenId,
            liquidity: liquidity,
            amount0Min: 0,
            amount1Min: 0,
            deadline: Math.floor(Date.now() / 1000) + 120,
        };
        calls.push(iface.encodeFunctionData("decreaseLiquidity", [decreaseData]));
    }

    // 2. Collect Fees
    const collectData = {
        tokenId: tokenId,
        recipient: wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
    };
    calls.push(iface.encodeFunctionData("collect", [collectData]));

    // 3. Burn NFT
    calls.push(iface.encodeFunctionData("burn", [tokenId]));

    try {
        const tx = await npm.multicall(calls);
        await waitWithTimeout(tx, TX_TIMEOUT_MS);
        console.log(`   Atomic Exit Successful! (Tx: ${tx.hash})`);
    } catch (e) {
        console.error(`   Atomic Exit Failed:`, e);
        throw e;
    }
}

export async function rebalancePortfolio(wallet: ethers.Wallet, configuredPool: Pool) {
    console.log(`\n[Rebalance] Calculating Optimal Swap...`);

    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const priceWethToUsdc =
        configuredPool.token0.address === WETH_TOKEN.address
            ? configuredPool.token0Price
            : configuredPool.token1Price;

    const wethAmount = CurrencyAmount.fromRawAmount(WETH_TOKEN, balWETH.toString());
    const usdcAmount = CurrencyAmount.fromRawAmount(USDC_TOKEN, balUSDC.toString());
    const wethValueInUsdc = priceWethToUsdc.quote(wethAmount);

    const router = new ethers.Contract(SWAP_ROUTER_ADDR, SWAP_ROUTER_ABI, wallet);

    if (usdcAmount.greaterThan(wethValueInUsdc)) {
        // Sell USDC
        const diff = usdcAmount.subtract(wethValueInUsdc);
        const amountToSell = diff.divide(2);

        if (parseFloat(amountToSell.toExact()) < 5) {
            console.log("   Balance is good enough. Skipping swap.");
            return;
        }

        console.log(`   [Swap] Selling ${amountToSell.toSignificant(6)} USDC for WETH`);

        const tx = await router.exactInputSingle({
            tokenIn: USDC_TOKEN.address,
            tokenOut: WETH_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountToSell.quotient.toString(),
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
        });
        await waitWithTimeout(tx, TX_TIMEOUT_MS);
    } else {
        // Sell WETH
        const diffValueInUsdc = wethValueInUsdc.subtract(usdcAmount);
        const amountToSellValue = diffValueInUsdc.divide(2);

        const priceUsdcToWeth =
            configuredPool.token0.address === USDC_TOKEN.address
                ? configuredPool.token0Price
                : configuredPool.token1Price;

        const amountToSell = priceUsdcToWeth.quote(amountToSellValue);

        if (parseFloat(amountToSell.toExact()) < 0.002) {
            console.log("   Balance is good enough. Skipping swap.");
            return;
        }

        console.log(`   [Swap] Selling ${amountToSell.toSignificant(6)} WETH for USDC`);

        const tx = await router.exactInputSingle({
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountToSell.quotient.toString(),
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
        });
        await waitWithTimeout(tx, TX_TIMEOUT_MS);
    }
}

export async function mintMaxLiquidity(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    tickLower: number,
    tickUpper: number
): Promise<string> {
    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const position = Position.fromAmounts({
        pool: configuredPool,
        tickLower,
        tickUpper,
        amount0: balWETH.toString(),
        amount1: balUSDC.toString(),
        useFullPrecision: true,
    });

    const { amount0: amount0Min, amount1: amount1Min } =
        position.mintAmountsWithSlippage(SLIPPAGE_TOLERANCE);

    const mintParams = {
        token0: configuredPool.token0.address,
        token1: configuredPool.token1.address,
        fee: POOL_FEE,
        tickLower,
        tickUpper,
        amount0Desired: position.mintAmounts.amount0.toString(),
        amount1Desired: position.mintAmounts.amount1.toString(),
        amount0Min: amount0Min.toString(),
        amount1Min: amount1Min.toString(),
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 120,
    };

    console.log(`\n[Mint] Minting new position...`);
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    const tx = await npm.mint(mintParams);
    const receipt = await waitWithTimeout(tx, TX_TIMEOUT_MS);

    const event = receipt.logs.find(
        (log: any) =>
            log.topics[0] ===
            ethers.id("Mint(uint256,address,address,uint24,int24,int24,uint128,uint256,uint256)")
    );

    if (!event) {
        throw new Error("Mint successful but failed to parse Token ID from logs.");
    }

    const newTokenId = ethers.AbiCoder.defaultAbiCoder()
        .decode(["uint256"], event.data)[0]
        .toString();

    console.log(`   Success! Token ID: ${newTokenId}`);
    return newTokenId;
}
