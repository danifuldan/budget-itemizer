import { getBudgetProvider, BudgetConnectionError } from "./budget-provider";

export { BudgetConnectionError };

export const getAllEnvelopes = () => getBudgetProvider().getAllCategories();
export const getAllAccounts = () => getBudgetProvider().getAllAccounts();
export const findMatchingTransaction = (
  accountName: string,
  amount: number,
  date: string,
  merchant: string,
  splitAmounts?: number[],
) => getBudgetProvider().findMatchingTransaction(accountName, amount, date, merchant, splitAmounts);
export const updateTransactionWithSplits = (
  transactionId: string,
  merchant: string,
  category: string,
  memo: string,
  totalAmount: number,
  splits?: { category: string; amount: number; memo?: string }[],
) =>
  getBudgetProvider().updateTransactionWithSplits(
    transactionId,
    merchant,
    category,
    memo,
    totalAmount,
    splits,
  );
export const createTransaction = (
  accountName: string,
  merchant: string,
  category: string,
  transactionDate: string,
  memo: string,
  totalAmount: number,
  splits?: { category: string; amount: number; memo?: string }[],
) =>
  getBudgetProvider().createTransaction(
    accountName,
    merchant,
    category,
    transactionDate,
    memo,
    totalAmount,
    splits,
  );
