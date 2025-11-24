import { ethers } from "ethers";
import { MAX_RETRIES } from "../config";

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(operation: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (retries > 0) {
            const delay = 1000 * (MAX_RETRIES - retries + 1);
            console.warn(`[Network] Request failed. Retrying in ${delay}ms... (${retries} left)`);
            await sleep(delay);
            return withRetry(operation, retries - 1);
        }
        throw error;
    }
}

export async function waitWithTimeout(
    tx: ethers.ContractTransactionResponse,
    timeoutMs: number
): Promise<ethers.ContractTransactionReceipt> {
    console.log(`[Tx] Waiting for confirmation: ${tx.hash}`);

    const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)),
    ]);

    if (!receipt) throw new Error("Tx dropped or failed");

    // 2. Cast the result as the correct type
    return receipt as ethers.ContractTransactionReceipt;
}
