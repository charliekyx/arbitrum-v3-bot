import axios from 'axios';
import { RSI } from 'technicalindicators';


// RSI (Relative Strength Index) is a momentum indicator used in technical analysis that 
// measures the magnitude of recent price changes to evaluate overbought or oversold conditions 
// in the price of a stock or other asset.

// It is displayed as an oscillator (a line graph that moves between two extremes) 
// and can have a reading from 0 to 100.

// RSI = 100 - 100 / (1 + RS)

// RS =  AVERAGE GAIN / AVERAGE LOSS

// from the above formula, the bigger the gain, the bigger RS is, then making 100 / (1 + RS) smaller, thus the final result RSI will be beigger

// rule of thumb
// if RSI > 70 The asset may be overvalued and is primed for a trend reversal or corrective pullback in price.
// if RSI <  30, the asset is undervalued

// Binance API URL for ETH/USDT (High liquidity reference)
const BINANCE_API_URL = 'https://api.binance.com/api/v3/klines';

export interface MarketAnalysis {
    rsi: number;
    price: number;
}


/**
 * Fetches the last 14 periods of candle data and calculates RSI.
 * In this case, looking at the period for last 14 hours
 * Uses 1-hour candles by default for trend analysis.
 */
export async function getEthRsi(interval: string = '1h', period: number = 14): Promise<number> {
    try {
        // Fetch 20 candles to ensure we have enough for the period calculation
        // Symbol: ETHUSDT
        const response = await axios.get(BINANCE_API_URL, {
            params: {
                symbol: 'ETHUSDT',
                interval: interval,
                limit: period + 10 
            }
        });

        // Binance response format: [ [open_time, open, high, low, close, ...], ... ]
        // We need the 'close' price (index 4)
        const closes: number[] = response.data.map((candle: any[]) => parseFloat(candle[4]));

        const inputRSI = {
            values: closes,
            period: period
        };

        const rsiResult = RSI.calculate(inputRSI);

        // Return the most recent RSI value
        if (rsiResult.length > 0) {
            const latestRsi = rsiResult[rsiResult.length - 1];
            return latestRsi;
        } else {
            throw new Error("Insufficient data to calculate RSI");
        }

    } catch (error) {
        console.error(`[Analytics] Failed to fetch RSI:`, error);
        // Return a neutral RSI (50) on failure so the bot keeps running without filtering
        return 50;
    }
}