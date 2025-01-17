import { inspect } from "util";
import type { Provider, TransactionReceipt } from "@ethersproject/abstract-provider";
import { type TypedDataSigner } from "@ethersproject/abstract-signer";
import { AddressZero, HashZero } from "@ethersproject/constants";
import { CliUx } from "@oclif/core";
import {
  BigNumber,
  Contract,
  ethers,
  Signer,
  type TypedDataField,
  Wallet,
  type Transaction,
  VoidSigner,
  type PopulatedTransaction,
  type Signature,
} from "ethers";
import { formatUnits, FunctionFragment, getAddress, Interface, Result } from "ethers/lib/utils";
import inquirer from "inquirer";
import keytar from "keytar";
import { ContractName, loadAbi } from "./contracts";
import { listWallets, loadWallet } from "./keystore";
import { LedgerSigner } from "./ledger";
import { NetworkName, Networks } from "./networks";

export type SignerType = "keystore" | "ledger" | "raw";
export const SignerTypes: SignerType[] = ["keystore", "ledger", "raw"];

const Chains: Record<number, string> = {
  0: "mainnet",
  5: "goerli",
};

export type RawTransaction = {
  to: string;
  abi: string;
  hex: string;
  raw: string;
};

export type TransactionLog = {
  event: string;
  args: Record<string, unknown>;
};

export const Permit: Record<string, Array<TypedDataField>> = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function pretty(value: unknown): string {
  return typeof value === "string" ? value : inspect(value, { depth: 10 });
}

// Signs a permit to transfer tokens.
export async function permit(
  signer: Signer,
  token: Contract,
  spender: Contract,
  amount: BigNumber,
  deadline: number
): Promise<Signature> {
  CliUx.ux.action.start("- Requesting signature");
  const address = await signer.getAddress();
  const provider = signer.provider;
  if (!provider) throw Error("");
  const chainId = (await provider.getNetwork()).chainId;
  const nonces = await token.nonces(address);
  const domain = { name: await token.name(), version: "1", chainId, verifyingContract: token.address };
  const values = { owner: address, spender: spender.address, value: amount, nonce: nonces, deadline };
  const signature = await (signer as unknown as TypedDataSigner)._signTypedData(domain, Permit, values);
  const sig = ethers.utils.splitSignature(signature);
  CliUx.ux.action.stop("done");
  return sig;
}

// Signs and executes the transaction and returns its emitted events, if a signer is provided.
// Otherwise, builds and returns a raw unsigned transaction string, if VoidSigner is provided.
// Pass the contracts parameter to decode the corresponding events. No other events are returned.
// The first of the passed contracts will be used to lookup the abi used for the raw transaction.
export async function run(
  tx: PopulatedTransaction,
  signer: Signer,
  contracts: Contract[]
): Promise<RawTransaction | TransactionLog[] | undefined> {
  if (signer instanceof VoidSigner) {
    if (!tx.to || !tx.data) return undefined;
    delete tx.from; // Raw tx must have "from" field
    const sighash = tx.data.slice(0, 10);
    const fragment = getFragment(contracts[0].interface, sighash);
    if (!fragment) return undefined;
    const abi = `[${fragment.format("json")}]`;
    const raw = ethers.utils.serializeTransaction(tx);
    return { to: tx.to, abi, hex: tx.data, raw };
  }

  CliUx.ux.action.start("- Submitting transaction");
  const response = await signer.sendTransaction(tx);
  CliUx.ux.action.stop("done");
  // Use stderr to not interfere with --json flag
  console.warn(`> ${getTxUrl(response)}`);
  CliUx.ux.action.start("- Processing transaction");
  const receipt = await response.wait();
  CliUx.ux.action.stop("done");
  const events = await decodeEvents(receipt, contracts);
  return events;
}

export function getFragment(interface_: Interface, sighash: string): FunctionFragment | undefined {
  for (const fragment of Object.values(interface_.functions)) {
    if (sighash === interface_.getSighash(fragment)) {
      return fragment;
    }
  }
}

export function getTxUrl(tx: Transaction): string {
  const chain = Chains[tx.chainId];
  const prefix = chain === "mainnet" ? "" : chain + ".";
  return `https://${prefix}etherscan.io/tx/${tx.hash}`;
}

// Converts union objects returned by ethers to plain objects.
export function normalizeRecord(r: Record<string, unknown> | Result): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(r)
      .filter((k) => isNaN(Number(k)))
      .map((k) => {
        return [k, normalizeRecordValue(r[k])];
      })
  );
}

export function normalizeRecords(rs: (Record<string, unknown> | Result)[]): Record<string, unknown>[] {
  return rs.map((r) => normalizeRecord(r));
}

function normalizeRecordValue(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(normalizeRecordValue);
  }
  if (val instanceof BigNumber) {
    return normalizeBigNumber(val);
  }
  return val;
}

export function normalizeHash(s: string | undefined): string {
  if (!s?.length) {
    return HashZero;
  }
  if (!s.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
    throw Error(`invalid hash: ${s}`);
  }
  return s.startsWith("0x") ? s : "0x" + s;
}

export function normalizeAddress(s: string | undefined): string {
  // getAddress throws on invalid input which is what we want here
  return !s?.length ? AddressZero : getAddress(s);
}

function normalizeBigNumber(n: BigNumber): string {
  try {
    return n.toNumber().toString();
  } catch {
    return formatUnits(n, 18);
  }
}

export async function getProvider(network: NetworkName, rpcUrl: string | undefined): Promise<Provider> {
  const url = rpcUrl ?? Networks[network].url;
  const provider = new ethers.providers.JsonRpcProvider(url);
  return provider;
}

export async function getSigner(
  network: NetworkName,
  rpcUrl: string | undefined,
  address: string | undefined,
  signer: SignerType,
  privateKey: string | undefined,
  account: string | undefined
): Promise<Signer> {
  const url = rpcUrl ?? Networks[network].url;
  const provider = new ethers.providers.JsonRpcProvider(url);

  let wallet: Signer;
  if (signer === "raw") {
    wallet = new VoidSigner(AddressZero);
  } else if (signer === "ledger") {
    // Use stderr to not interfere with --json flag
    console.warn("> Make sure the Ledger wallet is unlocked and the Ethereum application is open");
    if (!account) {
      account = "0";
    }
    wallet = new LedgerSigner(provider, "default", account);
    const address = await wallet.getAddress();
    // Use stderr to not interfere with --json flag
    console.warn(`> Using Ledger wallet ${address}`);
  } else if (privateKey) {
    wallet = new Wallet(privateKey);
    wallet = wallet.connect(provider);
  } else {
    if (!address) {
      const wallets = await listWallets();
      if (!wallets.length) {
        throw Error("Error: No private keys found. Use key import command.");
      }

      const res = await inquirer.prompt({
        name: "address",
        message: "Pick the wallet to sign the transaction:",
        type: "list",
        choices: wallets.map((w) => ({
          value: w.address,
          name: w.description ? `${w.address} - ${w.description}` : w.address,
        })),
      });

      address = res.address as string;
    } else {
      const wallets = await listWallets();
      if (!wallets.find((w) => w.address === address)) {
        throw Error(`No saved key for address ${address}`);
      }
    }

    let password = await keytar.getPassword("armada-cli", address);
    if (!password) {
      const res = await inquirer.prompt({
        name: "password",
        message: "Enter the wallet password:",
        type: "password",
      });
      password = res.password as string;
    }

    wallet = await loadWallet(address, password);
    wallet = wallet.connect(provider);
  }

  return wallet;
}

export async function getContract(
  network: NetworkName,
  abiDir: string | undefined,
  contract: ContractName,
  signerOrProvider: Signer | ethers.providers.Provider
): Promise<Contract> {
  const abi = await loadAbi(network, abiDir ?? Networks[network].abi, contract);
  if (signerOrProvider instanceof Signer) {
    const signer = signerOrProvider;
    const contract = new Contract(abi.address, abi.abi, signer.provider);
    const contractWithSigner = contract.connect(signer);
    return contractWithSigner;
  } else {
    const provider = signerOrProvider;
    const contract = new Contract(abi.address, abi.abi, provider);
    return contract;
  }
}

export async function decodeEvents(receipt: TransactionReceipt, contracts: Contract[]): Promise<TransactionLog[]> {
  const results = [];
  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i];
    for (const contract of contracts) {
      for (const fragment of Object.keys(contract.interface.events)) {
        const frag = contract.interface.events[fragment];
        let args;
        try {
          args = contract.interface.decodeEventLog(fragment, log.data, log.topics);
        } catch {
          continue;
        }
        results.push({ event: frag.name, args: normalizeRecord(args) });
      }
    }
  }
  return results;
}

// Returns all results of a paged function call (a function that accepts skip and size parameters).
export async function getAll(page: number, call: (skip: number, size: number) => Promise<Result[]>): Promise<Result[]> {
  const results: Result[] = [];
  while (page > 0) {
    const records = await call(results.length, page);
    results.push(...records);
    if (records.length !== page) {
      break;
    }
  }
  return results;
}
