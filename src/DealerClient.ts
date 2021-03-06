import { ContractWrappers } from "@0x/contract-wrappers";
import { MetamaskSubprovider } from "@0x/subproviders";
import { SignedOrder, SignedZeroExTransaction } from "@0x/types";
import { BigNumber } from "@0x/utils";
import { Web3Wrapper } from "@0x/web3-wrapper";
import { ERC20Token } from "@habsyr/erc20-token";
import assert from "assert";
import axios from "axios";
import { Provider, SupportedProvider, TransactionReceiptWithDecodedLogs } from "ethereum-types";
import { fromWei, toWei } from "web3-utils";

import {
  convertZeroExTransactionToDealerFill,
  createAndSignZeroExTransaction,
  GasPriority,
  getGasPrice,
  QuoteResponse,
  SwapResponse,
} from ".";
import { AuthorizationInfo, DealerOptions } from "./types";

/**
 * A simple client for the Zaidan dealer server.
 */
export class DealerClient {
  /** 2^256 - 1 represents an effectively "unlimited" allowance */
  public static MAX_ALLOWANCE = new BigNumber(2).exponentiatedBy(256).minus(1);

  /** The dealer API version this client is compatible with. */
  public static COMPATIBLE_VERSION = "3.0";

  /** Dealer server RPC server URL. */
  private readonly dealerUrl: URL;

  /** Base API path for the dealer server. */
  private readonly apiBase: string;

  /** ERC-20 token abstraction. */
  private erc20Token: ERC20Token;

  /**
   * An array of the currently supported pairs (as expected by `getQuote`).
   */
  public pairs: string[];

  /**
   * Maps tokenTicker => address for looking up common tokens.
   */
  public tokens: { [ticker: string]: string };

  /** Provides convenience methods for interacting with Ethereum. */
  public web3Wrapper: Web3Wrapper;

  /** Provider instance used to interact with Ethereum. */
  public provider: Provider | SupportedProvider | MetamaskSubprovider;

  /** Stores the configured Ethereum network ID. */
  public networkId: number;

  /** Stores the current user's coinbase address. */
  public coinbase: string;

  /** Initialized contract wrappers for interacting with the 0x system. */
  public contractWrappers: ContractWrappers;

  /** Set to 'true' after a successful .init(), must be called before use. */
  public initialized: boolean;

  /** Default gas price to use for allowance transactions (in wei). */
  public GAS_PRICE: BigNumber;

  /**
   * Transaction priority (according to ethgasstation.info API), defaults to
   * fast.
   */
  public txPriority: GasPriority;

  /**
   * Instantiate a new DealerClient. Prior to use, `client.init()` should
   * be called, which triggers a prompt for the user to allow MetaMask to
   * connect to the site.
   *
   * For usage in server-side applications, provide a second argument to the
   * constructor with an Ethereum JSONRPC URL, which will override the default
   * setting of attempting to load a web3 provider through the browser.
   *
   * @param dealerUri the base RPC API path for the dealer server
   * @param provider an ethereum provider
   * @param options optional configuration to allow non standard usages of the class
   */
  constructor(dealerUri: string, provider: Provider, options: DealerOptions = {}) {
    const { takerAddress, txPriority = "fast" } = options;
    this.initialized = false;

    this.provider = provider;
    this.web3Wrapper = new Web3Wrapper(this.provider);

    this.networkId = null;
    this.coinbase = takerAddress || null;

    this.txPriority = txPriority;
    this.contractWrappers = null;

    this.dealerUrl = new URL(dealerUri);
    this.apiBase = `${this.dealerUrl.href}api/v${DealerClient.COMPATIBLE_VERSION}`;
  }

  /**
   * Initialize a DealerClient instance. A call to `client.init()` will trigger
   * a MetaMask pop-up prompting the user to sign in, or allow the site access.
   *
   * If the user has already allowed site access, the prompt will be skipped.
   *
   * @returns A promise that resolves when initialization is complete.
   */
  public async init(): Promise<void> {
    this.networkId = await this.web3Wrapper.getNetworkIdAsync();
    this.contractWrappers = new ContractWrappers(
      this.provider,
      {
        chainId: this.networkId,
      },
    );

    // set coinbase if not already set as configuration option
    this.coinbase = this.coinbase || await this.web3Wrapper.getAvailableAddressesAsync().then(addresses => addresses[0]);

    this.erc20Token = new ERC20Token(this.contractWrappers.getProvider());
    this.GAS_PRICE = await getGasPrice(this.txPriority);
    this.pairs = await this._loadMarkets();
    this.tokens = await this._loadAssets();
    this.initialized = true;
  }

  /**
   * Check if a taker's address will be allowed to trade with the dealer based
   * on the dealer's configured whitelist/blacklist.
   *
   * @param takerAddress specify the taker address to check status for.
   * @returns information about taker's authorization status (see [AuthorizationInfo]).
   */
  public async getAuthorizationStatus(takerAddress: string = this.coinbase): Promise<AuthorizationInfo> {
    const { authorized, reason } = await this._call("authorized", "GET", { address: takerAddress });
    return { authorized, reason };
  }

  /**
   * Request a price quote a signed order from the dealer server. The response
   * includes price and fee information, as well as signed 0x order message for
   * the quote
   *
   * The order in the quote can be passed to `client.handleTrade()` which will
   * request a signature from the client according to ZEIP-18, and will prepare
   * a fill transaction for the dealer to fill.
   *
   * @param size the amount of tokens the user is selling/buying (in units of base asset)
   * @param symbol the token pair the swap is for (ex: "WETH/DAI")
   * @param side either 'bid' or 'ask' depending on desired quote side
   * @param takerAddress optionally override the default (must be able to sign)
   * @returns a price quote and signed maker order from the dealer server
   *
   * @example
   * ```javascript
   * const response = await client.getQuote(2, "WETH/DAI", "bid");
   *
   * // response object example:
   * response = {
   *   expiration: 1559170656.0712497,
   *   id: "e68b5aa8-f84c-45b8-a312-eef35bba480f",
   *   size: 2,
   *   price: 3,
   *   order: {}, // will be a full signed 0x order object
   *   fee: 0.2156,
   * }
   * ```
   */
  public async getQuote(
    size: number,
    symbol: string,
    side: string,
    takerAddress: string = this.coinbase,
  ): Promise<QuoteResponse> {
    assert(this.initialized, "not initialized (call .init() first)");
    assert(side === "bid" || side === "ask", 'side must be "bid" or "ask"');
    assert(this.pairs.includes(symbol), "unsupported token pair (see .pairs)");
    assert(typeof size === "number", "size must be a number");

    const response = await this._call("quote", "GET", { size, symbol, side, takerAddress });
    return response;
  }

  /**
   * An alternative interface for fetching a price quote using the concept of
   * an asset "swap" as opposed to a conventional base/quote bid/ask interface.
   *
   * Conceptually, the method allows you to swap `size` of `clientAsset` for an
   * equivalent amount of `dealerAsset`, based on the price returned by the
   * dealer server.
   *
   * Under the hood, the request still goes through as a bid/ask, but allows
   * for users to swap for specific amounts of assets that may only be served
   * as a quote asset. For example, you can swap 100 DAI for wrapped ETH even
   * if only the WETH/DAI pair is supported. Normally the quote would have to
   * be requested in terms of WETH.
   *
   * @param size the amount of takerAsset to swap for
   * @param clientAsset the ticker of the asset being sold (swapping for dealerAsset)
   * @param dealerAsset the ticker of the asset being bought that a price is quoted for
   * @returns A price quote and signed maker order from the dealer server.
   *
   * @example
   * ```javascript
   * // fetch a quote to swap 100 DAI for WETH
   * const quote = await dealer.getSwapQuote(100, "DAI", "WETH");
   *
   * // request for the trade to be filled
   * const txId = await dealer.handleTrade(quote);
   * ```
   */
  public async getSwapQuote(
    size: number,
    clientAsset: string,
    dealerAsset: string,
    takerAddress: string = this.coinbase,
  ): Promise<SwapResponse> {
    assert(this.initialized, "not initialized (call .init() first)");
    assert(typeof size === "number", "size must be a number");
    const dealerBase = `${dealerAsset}/${clientAsset}`;
    const clientBase = `${clientAsset}/${dealerAsset}`;
    assert(
      this.pairs.includes(dealerBase) || this.pairs.includes(clientBase),
      "configured dealer unable to server requested market",
    );

    const response = await this._call("swap", "GET", { size, dealerAsset, clientAsset, takerAddress });
    return response;
  }

  /**
   * Sign a 0x `fillOrder` transaction message, and submit it back to the
   * server for settlement. Signs a fill transaction for the entire specified
   * `takerAssetAmount`. Implements ZEIP-18 signing of the provided `order` object.
   *
   * Allowances should be checked prior to calling this method.
   *
   * @param order The signed maker order to submit for execution.
   * @param quoteId The unique quote UUID provided by the dealer server.
   * @returns A promise that resolves to txId of the trade.
   *
   * @example
   * ```javascript
   * // load a signed order from a quote
   * const quote = await dealer.getQuote(10, "WETH/DAI", "bid");
   *
   * // many fields available in the quote
   * const { order, id, price, size } = quote;
   *
   * // submit the trade for settlement
   * const txId = await dealer.handleTrade(quote);
   *
   * // get a link to the transaction on Etherscan
   * const link = dealer.getEtherscanLink(txId);
   *
   * // wait for trade to complete (throws if fails)
   * await dealer.waitForTransactionSuccessOrThrow(txId);
   * ```
   */
  public async handleTrade(quote: SwapResponse | QuoteResponse, takerAddress: string = this.coinbase): Promise<string> {
    const takerAmount = new BigNumber(quote.order.takerAssetAmount);
    const verifyingContractAddress = this.contractWrappers.exchange.address;

    let signedFillTx: SignedZeroExTransaction;
    try {
      signedFillTx = await createAndSignZeroExTransaction(
        this.provider,
        takerAddress,
        verifyingContractAddress,
        quote.order,
        takerAmount,
        new BigNumber(quote.gasPrice),
      );
    } catch (error) {
      throw new Error(`failed to sign fill transaction: ${error.message}`);
    }

    try {
      const req = await convertZeroExTransactionToDealerFill(this.provider, quote.order.chainId, signedFillTx, quote.id);
      const { txId } = await this._call("order", "POST", req);
      return txId;
    } catch (error) {
      throw new Error(`failed to submit trade: ${error.message}`);
    }
  }

  /**
   * Check if the user has set an allowance for the specified token. If the
   * method returns `false`, allowance can be set with `client.setAllowance`.
   *
   * Only works with supported tokens (see `client.tokens`).
   *
   * @param tokenTicker The token's short ticker (ex. "ZRX", "DAI").
   * @returns Resolves to `true` if the user has a non-0 allowance for the token.
   *
   * @example
   * ```javascript
   * // no allowance is set
   * await client.hasAllowance("DAI") // > false
   *
   * // will be `true` after setting allowance
   * await client.setAllowance("DAI")
   * await client.hasAllowance("DAI") // > true
   * ```
   */
  public async hasAllowance(tokenTicker: string): Promise<boolean> {
    const tokenAddress = this._getAddress(tokenTicker);
    const allowance = await this.erc20Token.getProxyAllowanceAsync(tokenAddress, this.coinbase);

    // 2**255 represents a remaining wei allowance for which a greater remaining
    // amount indicates the user most likely set an "unlimited" allowance at one point
    if (allowance.isGreaterThan(new BigNumber(2).exponentiatedBy(255) as any)) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * Set an unlimited proxy allowance for the 0x ERC20 Proxy contract for the
   * specified token ticker.
   *
   * Only works with supported ERC20 tickers (see `client.tokens`).
   *
   * @param tokenTicker The token's short ticker (ex. "ZRX", "DAI").
   * @returns A promise that resolve when TX is mined, rejects if it fails.
   *
   * @example
   * ```javascript
   * try {
   *   // can take a long time (~1 min), resolves after tx is mined
   *   await client.setAllowance("DAI");
   *
   *   console.log("failed to set allowance");
   * } catch {
   *   console.log("allowance is set");
   * }
   * ```
   */
  public async setAllowance(tokenTicker: string): Promise<TransactionReceiptWithDecodedLogs> {
    const tokenAddress = this._getAddress(tokenTicker);
    const from = this.coinbase;
    const gasPrice = this.GAS_PRICE;
    const txId = await this.erc20Token.setUnlimitedProxyAllowanceAsync(tokenAddress, { from, gasPrice: gasPrice as any });
    return this.web3Wrapper.awaitTransactionSuccessAsync(txId);
  }

  /**
   * Return the user's balance (in wei) of a specified supported token. Only
   * supported tickers will work (see `client.tokens`).
   *
   * Return balance is in base units (wei), and returned as a string. Convert
   * to a `BigNumber` instance for math.
   *
   * @param tokenTicker The token's short ticker (ex. "ZRX", "DAI").
   * @returns The user's balance of the token in wei, as a string.
   *
   * @example
   * ```javascript
   * // return value is in 'wei', so convert if needed before displaying
   * await client.getBalance("WETH") // > "12597034312510000"
   * ```
   */
  public async getBalance(tokenTicker: string): Promise<string> {
    const tokenAddress = this._getAddress(tokenTicker);
    const balance = await this.erc20Token.getBalanceAsync(tokenAddress, this.coinbase);
    return balance.toString();
  }

  /**
   * Wait for a specific Ethereum transaction to be successfully mined.
   *
   * @param txId A valid Ethereum transaction ID to wait for.
   * @returns Resolves when mined successfully, rejects if the TX failed.
   */
  public async waitForTransactionSuccessOrThrow(txId: string): Promise<void> {
    assert(/^0x[a-fA-F0-9]{64}$/.test(txId), "invalid transaction ID");
    await this.web3Wrapper.awaitTransactionSuccessAsync(txId);
  }

  /**
   * Turn a `string` or primitive `number` into a `BigNumber` for math reasons.
   *
   * @param n the primitive number value to convert.
   * @returns The number as a `BigNumber` instance.
   *
   * @example
   * ```javascript
   * let bigNum = client.makeBigNumber("10") // use any BigNumber methods
   * bigNum = client.makeBigNumber(10)       // works with strings or numbers
   * ```
   */
  public makeBigNumber(n: number | string): BigNumber {
    assert(typeof n === "number" || typeof n !== "string", '"n" must be a number or string number');
    return new BigNumber(n);
  }

  /**
   * Convert a number of tokens, denominated in the smallest unit - "wei" - to
   * "full" units, called "ether". One ether = 1*10^18 wei.
   *
   * All contract calls require amounts in wei, but the user should be shown
   * amounts in ether. All values are strings to avoid precision issues.
   *
   * @param weiAmount The token amount in wei to convert.
   * @returns The same amount in ether, string returned for precision.
   *
   * @example
   * ```javascript
   * client.fromWei("100000000000000000000") // > "100"
   * client.fromWei("10000000000000000000")   // > "10"
   * ```
   */
  public fromWei(weiAmount: string): string {
    assert(typeof weiAmount === "string", "pass amounts as strings to avoid precision errors");
    return fromWei(weiAmount);
  }

  /**
   * Convert a number of tokens (full units, called "ether") to "wei", the
   * smallest denomination of most ERC-20 tokens with 18 decimals.
   *
   * All contract calls require amounts in wei, but the user should be shown
   * amounts in ether. All values are strings to avoid precision issues.
   *
   * @param etherAmount The token amount to convert.
   * @returns The same amount in wei, string used for precision.
   *
   * @example
   * ```javascript
   * client.toWei("10")  // > "10000000000000000000"
   * client.toWei("1") // > "1000000000000000000"
   * ```
   */
  public toWei(etherAmount: string): string {
    assert(typeof etherAmount === "string", "pass amounts as strings to avoid precision errors");
    return toWei(etherAmount);
  }

  /**
   * Returns the URL of the Etherscan status page for the specified TX ID.
   *
   * Useful for generating a link to show the user a transaction's status.
   *
   * @param txId A valid Ethereum transaction ID.
   * @returns A string that can be used as a hyperlink to etherscan.
   */
  public getEtherscanLink(txId: string): string {
    assert(/^0x[a-fA-F0-9]{64}$/.test(txId), "invalid transaction ID");

    const prefix = p => `https://${p}.etherscan.io/tx/${txId}`;
    switch (this.networkId) {
      case 1: return prefix("www");
      case 3: return prefix("ropsten");
      case 4: return prefix("rinkeby");
      case 42: return prefix("kovan");
      default: throw new Error("etherscan unsupported on current network");
    }
  }

  /**
   * Return an array containing the list of supported token tickers.
   *
   * @returns The supported token tickers.
   *
   * @example
   * ```javascript
   * client.supportedTickers() // > [ "DAI", "WETH", "ZRX ]
   * ```
   */
  public supportedTickers(): string[] {
    return Object.keys(this.tokens);
  }

  private async _callAny(url: string, method: "GET" | "POST", data?: any): Promise<any> {
    const response = await axios(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        params: method === "GET" && data ? data : null,
        data: method === "POST" ? data : null,
      },
    );
    return response.data;
  }

  private async _call(endpoint: string, method: "GET" | "POST", data?: any): Promise<any> {
    return this._callAny(`${this.apiBase}/${endpoint}`, method, data);
  }

  private _getAddress(ticker: string): string {
    const tokenAddress = this.tokens[ticker];
    assert(tokenAddress, "unsupported token ticker");
    return tokenAddress;
  }

  private async _loadMarkets(): Promise<string[]> {
    return this._call("markets", "GET");
  }

  private async _loadAssets(): Promise<any> {
    return this._call("assets", "GET");
  }
}
