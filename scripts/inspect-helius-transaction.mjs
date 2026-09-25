import { readFileSync } from "node:fs";
import process from "node:process";

const signature = process.argv[2];
const wallet = process.argv[3];
if (!signature) throw new Error("Usage: node scripts/inspect-helius-transaction.mjs <signature>");

const environment = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => {
      const value = match[2] ?? "";
      const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      return [match[1], quoted ? value.slice(1, -1) : value];
    }),
);
const apiKey = environment["HELIUS_API_KEY"];
if (!apiKey) throw new Error("HELIUS_API_KEY is required");

const response = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(apiKey)}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ transactions: [signature] }),
});
if (!response.ok) throw new Error(`Helius request failed with ${String(response.status)}`);
const payload = await response.json();
const transaction = payload[0];
if (!transaction) throw new Error("Transaction was not returned");

console.log(JSON.stringify({
  topLevelFields: Object.keys(transaction),
  type: transaction.type,
  tokenTransfers: transaction.tokenTransfers?.map((transfer) => ({
    fields: Object.keys(transfer),
    tokenAmount: transfer.tokenAmount,
    rawTokenAmount: transfer.rawTokenAmount,
  })),
  accountData: transaction.accountData
    ?.filter((account) => account.account === wallet || account.tokenBalanceChanges?.length > 0)
    .map((account) => ({
      fields: Object.keys(account),
      accountIsWallet: wallet ? account.account === wallet : undefined,
      nativeBalanceChange: account.nativeBalanceChange,
      tokenBalanceChanges: account.tokenBalanceChanges.map((change) => ({
        fields: Object.keys(change),
        userIsWallet: wallet ? change.userAccount === wallet : undefined,
        rawTokenAmount: change.rawTokenAmount,
      })),
    })),
}, null, 2));
