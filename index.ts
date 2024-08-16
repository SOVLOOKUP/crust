import { typesBundleForPolkadot, typesAlias } from "@crustio/type-definitions";
import { Keyring } from "@polkadot/keyring";
import type { UnixFSEntry } from "ipfs-unixfs-exporter";
import { KeyringPair } from "@polkadot/keyring/types";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { ApiPromise, WsProvider } from "@polkadot/api";
await cryptoWaitReady();

const mainNet = "wss://rpc.crust.network";
const testNet = "wss://rpc-rocky.crust.network";

export interface StoredResource {
  hash: string;
  cid: string;
}

export interface OrderStatus {
  file_size: string;
  spower: string;
  expired_at: string;
  calculated_at: string;
  amount: string;
  prepaid: string;
  reported_replica_count: string;
  remaining_paid_count: string;
  replicas: {
    [key: string]: {
      who: string;
      valid_at: string;
      anchor: string;
      is_reported: boolean;
      created_at: null | string;
    };
  };
}

export interface CrustOpt {
  seeds: string;
  net?: "main" | "test";
}

export class Crust {
  #api: ApiPromise;
  #krp: KeyringPair;
  #provider: WsProvider;
  constructor(parameters: CrustOpt) {
    parameters = parameters ?? {};
    parameters.net = parameters.net ?? "main";
    this.#krp = new Keyring({ type: "sr25519" }).addFromUri(parameters.seeds);

    this.#provider = new WsProvider(
      parameters.net === "main" ? mainNet : testNet
    );

    this.#api = new ApiPromise({
      provider: this.#provider,
      typesBundle: typesBundleForPolkadot,
      typesAlias,
    });
  }

  placeStorageOrder = async (
    entry: Pick<UnixFSEntry, "cid" | "size" | "type">,
    tips = 0
  ) => {
    await this.#api.isReadyOrError;
    const stored = await this.getOrderStatus(entry.cid.toV1().toString());

    if (stored !== null) {
      throw new Error("File has already been stored");
    }

    const fileCid = entry.cid.toV1().toString();
    const fileSize = entry.size;
    const memo = entry.type === "directory" ? "folder" : "";
    const tx = this.#api.tx.market.placeStorageOrder(
      fileCid,
      fileSize,
      tips,
      memo
    );

    return new Promise<StoredResource>((resolve, reject) => {
      tx.signAndSend(this.#krp, async (result) => {
        const { isInBlock, events, txHash } = result;

        if (isInBlock) {
          let cid: string;
          events.forEach(({ event: { method, data } }) => {
            if (method === "FileSuccess") {
              // get file cid
              cid = data.pop()?.toHuman() as string;
            }
            if (method === "ExtrinsicSuccess") {
              // place storage success
              resolve({ hash: txHash.toHex(), cid });
            }
          });
        }
      }).catch((e) => {
        reject(e);
      });
    });
  };

  addPrepaidAmount = async (
    fileCid: string,
    amount: number
  ): Promise<StoredResource> => {
    await this.#api.isReadyOrError;
    const tx = this.#api.tx.market.addPrepaid(fileCid, amount);

    return new Promise((resolve, reject) => {
      tx.signAndSend(this.#krp, async (result) => {
        if (result.isInBlock) {
          // @ts-ignore
          const { InBlock } = result.status.toHuman();
          resolve({ hash: InBlock, cid: fileCid });
        }
      }).catch((e) => {
        reject(e);
      });
    });
  };

  getOrderStatus = async (fileCid: string): Promise<OrderStatus | null> => {
    await this.#api.isReadyOrError;
    const res = await this.#api.query.market.filesV2(fileCid);
    return res.toHuman() as unknown as OrderStatus | null;
  };
}
