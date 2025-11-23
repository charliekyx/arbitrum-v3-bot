// config.ts
import { Token } from '@uniswap/sdk-core';
import { FeeAmount } from '@uniswap/v3-sdk';
import * as dotenv from 'dotenv';

dotenv.config();

/// Default to SEPOLIA if not specified
const NETWORK = process.env.NETWORK || 'SEPOLIA';

console.log(`[Config] Current Network: ${NETWORK}`);

// --- ABI ---

// Both USDC and WETH are ERC-20 tokens. They are smart contracts that strictly follow the EIP-20 standard
// Because they share the same standard interface, you can use the exact same ERC20_ABI to query the balance for USDC, WETH, UNI, ARB, or any other standard token.
// important!!: Native ETH (the asset used to pay for Gas) is not an ERC-20 token

export const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

// Uniswap V3 Pool abi 
export const POOL_ABI = [
     // Standard ERC-721 Functions (Required for Recovery Logic)
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",

    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function tickSpacing() view returns (int24)"
];

// non-fungible position manager contract
// https://arbiscan.io/address/0xC36442b4a4522E871399CD717aBDD847Ab11FE88#code
export const NPM_ABI = [
    // Standard ERC-721 Functions (Required for Recovery Logic)
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",

    // Uniswap V3 Specific Functions
    "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
    "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
    "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
    "function burn(uint256 tokenId) payable"
];
let CHAIN_ID: number;
let WETH_TOKEN_CONF: Token;
let USDC_TOKEN_CONF: Token;
let NPM_ADDR_CONF: string;
let V3_FACTORY_ADDR_CONF: string;
let SWAP_ROUTER_ADDR_CONF: string;

if (NETWORK === 'MAINNET') {
    // Arbitrum One Mainnet
    CHAIN_ID = 42161;

    WETH_TOKEN_CONF = new Token(CHAIN_ID, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'.toLocaleLowerCase(), 18, 'WETH', 'Wrapped Ether');
    USDC_TOKEN_CONF = new Token(CHAIN_ID, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'.toLocaleLowerCase(), 6, 'USDC', 'USD Coin');

    NPM_ADDR_CONF = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88".toLocaleLowerCase();

    V3_FACTORY_ADDR_CONF = "0x1F98431c8aD98523631AE4a59f267346ea31F984".toLocaleLowerCase();
    SWAP_ROUTER_ADDR_CONF = "0xE592427A0AEce92De3Edee1F18E0157C05861564".toLocaleLowerCase();
} else {
    // Sepolia Testnet
    CHAIN_ID = 11155111;
    
   // Sepolia WETH (Commonly used address)
    WETH_TOKEN_CONF = new Token(CHAIN_ID, '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'.toLocaleLowerCase(), 18, 'WETH', 'Wrapped Ether');
    
   // Sepolia USDC (Circle Official Testnet USDC)
    USDC_TOKEN_CONF = new Token(CHAIN_ID, '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'.toLocaleLowerCase(), 6, 'USDC', 'USD Coin');
    
    // Uniswap V3 Addresses on Sepolia
    NPM_ADDR_CONF = "0x1238536071E1c677A632429e3655c799b22cDA52".toLocaleLowerCase(); 
    V3_FACTORY_ADDR_CONF = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c".toLocaleLowerCase();
    SWAP_ROUTER_ADDR_CONF = "0x3bFA4769FB09e8893f006F12D45212349f9aE488".toLocaleLowerCase(); // SwapRouter02 on Sepolia
}

export const CURRENT_CHAIN_ID = CHAIN_ID;
export const WETH_TOKEN = WETH_TOKEN_CONF;
export const USDC_TOKEN = USDC_TOKEN_CONF;
export const NONFUNGIBLE_POSITION_MANAGER_ADDR = NPM_ADDR_CONF;
export const V3_FACTORY_ADDR = V3_FACTORY_ADDR_CONF;
export const SWAP_ROUTER_ADDR = SWAP_ROUTER_ADDR_CONF;

// Fee Tier 0.3% (Medium) - Common for standard pairs
export const POOL_FEE = FeeAmount.MEDIUM;