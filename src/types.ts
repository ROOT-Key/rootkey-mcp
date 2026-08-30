/**
 * Only the response shapes the server actually inspects are typed. Everything else is passed
 * through to the caller verbatim, so a new API field reaches the user without a code change.
 */

export interface FileSummary {
  id?: string;
  name?: string;
  status?: string;
  createdAt?: string;
  /** Read back after an upload to tell our new row apart from a same-named neighbour. */
  sizeBytes?: number | string;
  [key: string]: unknown;
}

/** Reserved key on a record row; the row's own columns sit at the top level beside it. */
export interface RecordMeta {
  id?: string;
  parentId?: string | null;
  status?: string;
  versionsNumber?: number;
  createdAt?: string;
}

export interface RecordRow {
  __meta?: RecordMeta;
  [column: string]: unknown;
}

export interface RecoveryPoint {
  id?: string;
  name?: string;
  status?: string;
  progress?: number;
  createdAt?: string;
  [key: string]: unknown;
}

export interface CreateVaultResponse {
  chainId?: number;
  address?: string;
  name?: string;
  description?: string | null;
}

export interface CreateSmartContractResponse {
  chainId?: number;
  transactionHash?: string;
}
