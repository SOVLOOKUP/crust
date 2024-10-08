import { typesBundleForPolkadot, typesAlias } from "@crustio/type-definitions";
import { Keyring } from "@polkadot/keyring";
import { KeyringPair } from "@polkadot/keyring/types";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { ApiPromise, WsProvider } from "@polkadot/api";

const mainNet = "wss://rpc.crust.network";
const testNet = "wss://rpc-rocky.crust.network";
const countDownSec = 60;

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

export class CrustNoSeed {
  #api: ApiPromise;
  #net: string;
  #countDown: NodeJS.Timeout;
  constructor(parameters?: Omit<CrustOpt, "seeds">) {
    parameters = parameters ?? {};
    parameters.net = parameters.net ?? "main";
    this.#net = parameters.net === "main" ? mainNet : testNet;

    this.#api = new ApiPromise({
      provider: new WsProvider(this.#net),
      typesBundle: typesBundleForPolkadot,
      typesAlias,
    });
    // 1分钟无活动则自动断开链接链接
    this.#setCountDown();
  }

  #setCountDown = () =>
    (this.#countDown = setTimeout(this.disconnect, countDownSec * 1000));

  isReadyOrError = async () => {
    if (!this.isConnected()) {
      await this.connect();
    }
    await this.#api.isReadyOrError;
    clearTimeout(this.#countDown);
    this.#setCountDown();
  };

  disconnect = async () => await this.#api.disconnect();
  connect = async () => {
    this.#api = new ApiPromise({
      provider: new WsProvider(this.#net),
      typesBundle: typesBundleForPolkadot,
      typesAlias,
    });
    await this.#api.isReadyOrError;
  };
  isConnected = () => this.#api.isConnected;
  getTx = (extrinsic: Uint8Array | string) => this.#api.tx(extrinsic);

  getPlaceStorageOrderRaw = async (entry: {
    cid: string;
    type: "directory" | "others";
    size?: bigint;
    tips?: bigint;
  }) => {
    await this.isReadyOrError();

    const fileCid = entry.cid;
    const fileSize = entry.size;
    const memo = entry.type === "directory" ? "folder" : "";

    const tx = this.#api.tx.market.placeStorageOrder(
      fileCid,
      fileSize ?? 0,
      entry.tips ?? 0,
      memo
    );

    return tx.toHex();
  };

  getAddPrepaidAmountRaw = async (fileCid: string, amount: number) => {
    await this.isReadyOrError();
    const tx = this.#api.tx.market.addPrepaid(fileCid, amount);
    return tx.toHex();
  };

  placeStorageOrderRaw = async (extrinsic: Uint8Array | string) => {
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

  addPrepaidAmountRaw = async (extrinsic: Uint8Array | string) => {
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

export class Crust extends CrustNoSeed {
  #krp: KeyringPair;
  constructor(parameters: CrustOpt) {
    super(parameters);
    this.#krp = new Keyring({ type: "sr25519" }).addFromUri(parameters.seeds);
  }

  signPlaceStorageOrderEx = async (ex: string) => {
    await this.isReadyOrError();
    const tx = this.getTx(ex);
    if (tx.method.method === "placeStorageOrder") {
      const signedTx = await tx.signAsync(this.#krp);
      return signedTx.toHex();
    } else {
      throw new Error("Method error");
    }
  };

  signAddPrepaidAmountEx = async (ex: string) => {
    await this.isReadyOrError();
    const tx = this.getTx(ex);
    if (tx.method.method === "addPrepaid") {
      const signedTx = await tx.signAsync(this.#krp);
      return signedTx.toHex();
    } else {
      throw new Error("Method error");
    }
  };

  placeStorageOrder = async (entry: {
    cid: string;
    size: bigint;
    type: "directory" | "others";
    tips?: bigint;
  }): Promise<StoredResource> => {
    const ex = await this.getPlaceStorageOrderRaw(entry);
    const tx = (await this.getTx(ex).signAsync(this.#krp)).toHex();
    return await this.placeStorageOrderRaw(tx);
  };

  addPrepaidAmount = async (
    fileCid: string,
    amount: number
  ): Promise<StoredResource> => {
    const ex = await this.getAddPrepaidAmountRaw(fileCid, amount);
    const tx = (await this.getTx(ex).signAsync(this.#krp)).toHex();
    return await this.addPrepaidAmountRaw(tx);
  };
}

export const getUseCrust = <T extends CrustNoSeed>(newCrust: () => T) => {
  let crust: T;

  const validReady = async <T extends CrustNoSeed>(newCrust: () => T) => {
    try {
      await crust.isReadyOrError();
      return crust;
    } catch (error) {
      // @ts-ignore
      crust = newCrust();
      return await validReady(newCrust);
    }
  };

  const useCrust = async <T extends CrustNoSeed>(): Promise<T> => {
    await cryptoWaitReady();

    if (!crust) {
      crust = newCrust();
    }
    // @ts-ignore
    return await validReady(newCrust);
  };

  return useCrust;
};
