import { typesBundleForPolkadot, typesAlias } from "@crustio/type-definitions";
import { Keyring } from "@polkadot/keyring";
import { KeyringPair } from "@polkadot/keyring/types";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { ApiPromise, WsProvider } from "@polkadot/api";

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

export const newCrust = async (parameters: CrustOpt) => {
  await cryptoWaitReady();
  return new Crust(parameters);
};

export const newCrustNoSeed = async (parameters: Omit<CrustOpt, "seeds">) => {
  await cryptoWaitReady();
  return new CrustNoSeed(parameters);
};

export class Crust {
  #api: ApiPromise;
  #krp: KeyringPair;
  #provider: WsProvider;
  constructor(parameters: CrustOpt) {
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

  isReadyOrError = async () => await this.#api.isReadyOrError;

  placeStorageOrder = async (entry: {
    cid: string;
    size: bigint;
    type: "directory" | "others";
    tips?: bigint;
  }) => {
    await this.isReadyOrError();

    const fileCid = entry.cid;
    const fileSize = entry.size;
    const memo = entry.type === "directory" ? "folder" : "";
    const tx = this.#api.tx.market.placeStorageOrder(
      fileCid,
      fileSize,
      entry.tips ?? 0,
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
    await this.isReadyOrError();

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
    await this.isReadyOrError();
    const res = await this.#api.query.market.filesV2(fileCid);
    return res.toHuman() as unknown as OrderStatus | null;
  };
}

export class CrustNoSeed {
  #api: ApiPromise;
  #provider: WsProvider;
  constructor(parameters?: Omit<CrustOpt, "seeds">) {
    parameters = parameters ?? {}
    parameters.net = parameters.net ?? "main";

    this.#provider = new WsProvider(
      parameters.net === "main" ? mainNet : testNet
    );

    this.#api = new ApiPromise({
      provider: this.#provider,
      typesBundle: typesBundleForPolkadot,
      typesAlias,
    });
  }

  isReadyOrError = async () => await this.#api.isReadyOrError;

  placeStorageOrderRaw = async (extrinsic: Uint8Array) => {
    await this.isReadyOrError();
    const tx = this.#api.tx(extrinsic);

    return new Promise<StoredResource>((resolve, reject) => {
      if (tx.method.method === "placeStorageOrder") {
        tx.send(async (result) => {
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
      } else {
        reject(new Error("Only Support placeStorageOrder method"));
      }
    });
  };

  addPrepaidAmountRaw = async (extrinsic: Uint8Array) => {
    await this.isReadyOrError();
    const tx = this.#api.tx(extrinsic);
    const cid = tx.method.toHuman()["args"]?.cid;

    return new Promise<StoredResource>((resolve, reject) => {
      if (typeof cid !== "string") {
        reject(new Error("Not Valid Cid"));
      } else {
        if (tx.method.method === "addPrepaid") {
          tx.send(async (result) => {
            if (result.isInBlock) {
              // @ts-ignore
              const { InBlock } = result.status.toHuman();
              resolve({ hash: InBlock, cid });
            }
          }).catch((e) => {
            reject(e);
          });
        } else {
          reject(new Error("Only Support addPrepaid method"));
        }
      }
    });
  };

  getOrderStatus = async (fileCid: string): Promise<OrderStatus | null> => {
    await this.isReadyOrError();
    const res = await this.#api.query.market.filesV2(fileCid);
    return res.toHuman() as unknown as OrderStatus | null;
  };
}


let crust: CrustNoSeed;

const validReady = async (parameters: Omit<CrustOpt, "seeds">) => {
  try {
    await crust.isReadyOrError();
    return crust;
  } catch (error) {
    crust = await newCrustNoSeed(parameters);
    return await validReady(parameters);
  }
};

export const useCrustNoSeed = async (parameters: Omit<CrustOpt, "seeds">) => {
  if (!crust) {
    crust = await newCrustNoSeed(parameters);
  }

  return await validReady(parameters);
};
