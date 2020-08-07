// // @flow
import {
  Logger,
  stringifyError,
  stringifyData
} from '../../../../utils/logging';
import type {
  BaseSignRequest,
  AddressedUtxo,
} from '../types';
import type { UtxoLookupMap }  from '../utils';
import { utxosToLookupMap, verifyFromBip44Root }  from '../utils';
import type {
  SendFunc,
  TxBodiesFunc,
  SignedRequest,
} from '../../lib/state-fetch/types';
import {
  SendTransactionError,
  InvalidWitnessError,
} from '../../../common/errors';
import type {
  BroadcastTrezorSignedTxResponse,
  // PrepareAndBroadcastLedgerSignedTxResponse
} from '../../index';
// import type {
//   LedgerSignTxPayload,
// } from '../../../../domain/HWSignTx';
// import type {
//   InputTypeUTxO,
//   OutputTypeAddress,
//   OutputTypeChange,
//   SignTransactionResponse as LedgerSignTxResponse,
//   Witness
// } from '@cardano-foundation/ledgerjs-hw-app-cardano';
import { toDerivationPathString } from '@emurgo/ledger-connect-handler';
import type {
  CardanoSignTransaction,
  CardanoInput,
  CardanoOutput,
  CardanoWithdrawal,
  CardanoCertificate,
  CardanoAddressParameters,
  CardanoCertificatePointer,
} from 'trezor-connect/lib/types/networks/cardano';
import {
  CERTIFICATE_TYPE,
  ADDRESS_TYPE,
} from 'trezor-connect/lib/constants/cardano';
import type {
  Address, Value, Addressing,
} from '../../lib/storage/models/PublicDeriver/interfaces';
import { HaskellShelleyTxSignRequest } from './HaskellShelleyTxSignRequest';
import {
  Bip44DerivationLevels,
} from '../../lib/storage/database/walletTypes/bip44/api/utils';
import {
  ChainDerivations,
} from '../../../../config/numbersConfig';

import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import type { CoreAddressT } from '../../lib/storage/database/primitives/enums';
import { CoreAddressTypes } from '../../lib/storage/database/primitives/enums';
import { range } from 'lodash';
import { toHexOrBase58 } from '../../lib/storage/bridge/utils';

// // ==================== TREZOR ==================== //
// /** Generate a payload for Trezor SignTx */
export async function createTrezorSignTxPayload(
  signRequest: HaskellShelleyTxSignRequest,
  byronNetworkMagic: number,
  networkId: number,
): Promise<$Exact<CardanoSignTransaction>> {
  const txBody = signRequest.self().unsignedTx.build();

  // Inputs
  const trezorInputs = _transformToTrezorInputs(
    signRequest.self().senderUtxos
  );

  // Output
  const trezorOutputs = _generateTrezorOutputs(
    txBody.outputs(),
    signRequest.self().changeAddr
  );

  // withdrawals
  const withdrawals = txBody.withdrawals();
  const getStakingKeyPath = () => {
    // TODO: this entire block is super hacky
    // need to instead pass in a mapping from wallet addresses to addressing
    // or add something similar to the sign request
    if (withdrawals != null && withdrawals.len() > 1) {
      throw new Error(`${nameof(createTrezorSignTxPayload)} don't support multiple staking keys for one wallet`);
    }
    // assume the withdrawal is the same path as the UTXOs being spent
    // so just take the first UTXO arbitrarily and change it to the staking key path
    const firstUtxo = signRequest.self().senderUtxos[0];
    if (firstUtxo.addressing.startLevel !== Bip44DerivationLevels.PURPOSE.level) {
      throw new Error(`${nameof(createTrezorSignTxPayload)} unexpected addressing start level`);
    }
    const stakingKeyPath = [...firstUtxo.addressing.path];
    stakingKeyPath[Bip44DerivationLevels.CHAIN.level] = ChainDerivations.CHIMERIC_ACCOUNT;
    stakingKeyPath[Bip44DerivationLevels.ADDRESS.level] = 0;
    return stakingKeyPath;
  };
  const trezorWithdrawals = withdrawals == null
    ? undefined
    : formatTrezorWithdrawals(
      withdrawals,
      [getStakingKeyPath()],
    );

  // certificates
  const certificates = txBody.certs();
  const trezorCertificates = certificates == null
    ? undefined
    : formatTrezorCertificates(
      certificates,
      range(0, certificates.len()).map(_i => getStakingKeyPath()),
    );

  const metadata = signRequest.txMetadata();

  return {
    inputs: trezorInputs,
    outputs: trezorOutputs,
    fee: txBody.fee().to_str(),
    ttl: txBody.ttl().toString(),
    certificates: trezorCertificates,
    withdrawals: trezorWithdrawals,
    metadata: metadata == null
      ? undefined
      : Buffer.from(metadata.to_bytes()).toString('hex'),
    protocolMagic: byronNetworkMagic,
    networkId,
  };
}

function formatTrezorWithdrawals(
  withdrawals: RustModule.WalletV4.Withdrawals,
  path: Array<Array<number>>,
): Array<CardanoWithdrawal> {
  const result = [];

  if (withdrawals.len() > 1) {
    // TODO: this is a problem with our CDDL library
    // since it saves withdrawals as a BTreeMap
    // which may not be the same order as present in the original tx binary
    // so we don't know which order the list we pass to Trezor should be
    throw new Error(`${nameof(formatTrezorWithdrawals)} only 1 withdrawal per tx supported`);
  }
  if (withdrawals.len() === 1) {
    // TODO: this is a problem with our CDDL library
    // since it only exposes a "get" function and no way to iterate over keys
    // and we don't know what reward address will be here before-hand
    throw new Error(`${nameof(formatTrezorWithdrawals)} withdrawals not supported`);
  }
  // for (let i = 0; i < withdrawals.len(); i++) {
  //   result.push({
  //     amount: withdrawals.get(i).to_str(),
  //     path: path[i],
  //   });
  // }
  return result;
}
function formatTrezorCertificates(
  certificates: RustModule.WalletV4.Certificates,
  path: Array<Array<number>>,
): Array<CardanoCertificate> {
  const result = [];
  for (let i = 0; i < certificates.len(); i++) {
    const cert = certificates.get(i);
    if (cert.as_stake_registration() != null) {
      result.push({
        type: CERTIFICATE_TYPE.StakeRegistration,
        path: path[i],
      });
      continue;
    }
    if (cert.as_stake_deregistration() != null) {
      result.push({
        type: CERTIFICATE_TYPE.StakeDeregistration,
        path: path[i],
      });
      continue;
    }
    const delegationCert = cert.as_stake_delegation();
    if (delegationCert != null) {
      result.push({
        type: CERTIFICATE_TYPE.StakeDelegation,
        path: path[i],
        pool: Buffer.from(delegationCert.pool_keyhash().to_bytes()).toString('hex'),
      });
      continue;
    }
    throw new Error(`${nameof(formatTrezorCertificates)} Trezor doesn't support this certificate type`);
  }
  return result;
}

// /** Send a transaction and save the new change address */
export async function broadcastTrezorSignedTx(
  signedTxRequest: SignedRequest,
  sendTx: SendFunc,
): Promise<BroadcastTrezorSignedTxResponse> {
  Logger.debug(`hwTransactions::${nameof(broadcastTrezorSignedTx)}: called`);
  try {
    const backendResponse = await sendTx(signedTxRequest);
    Logger.debug(`hwTransactions::${nameof(broadcastTrezorSignedTx)}: success`);

    return backendResponse;
  } catch (sendTxError) {
    Logger.error(`hwTransactions::${nameof(broadcastTrezorSignedTx)} error: ` + stringifyError(sendTxError));
    if (sendTxError instanceof InvalidWitnessError) {
      throw new InvalidWitnessError();
    }
    throw new SendTransactionError();
  }
}

function _transformToTrezorInputs(
  inputs: Array<AddressedUtxo>
): Array<CardanoInput> {
  for (const input of inputs) {
    verifyFromBip44Root(input.addressing);
  }
  return inputs.map(input => ({
    prev_hash: input.tx_hash,
    prev_index: input.tx_index,
    path: toDerivationPathString(input.addressing.path),
  }));
}

function _generateTrezorOutputs(
  txOutputs: RustModule.WalletV4.TransactionOutputs,
  changeAddrs: Array<{| ...Address, ...Value, ...Addressing |}>,
): Array<CardanoOutput> {
  const result = [];
  for (let i = 0; i < txOutputs.len(); i++) {
    const output = txOutputs.get(i);
    const address = output.address();
    const jsAddr = toHexOrBase58(output.address());

    const changeAddr = changeAddrs.find(change => jsAddr === change.address);
    if (changeAddr != null) {
      verifyFromBip44Root(changeAddr.addressing);
      result.push({
        addressParameters: toTrezorAddressParameters(
          address,
          changeAddr.addressing.path
        ),
        amount: output.amount().to_str(),
      });
    } else {
      const byronWasm = RustModule.WalletV4.ByronAddress.from_address(address);
      result.push({
        address: byronWasm == null
          ? address.to_bech32()
          : byronWasm.to_base58(),
        amount: output.amount().to_str(),
      });
    }
  }
  return result;
}

export function toTrezorAddressParameters(
  address: RustModule.WalletV4.Address,
  path: Array<number>,
): CardanoAddressParameters {
  {
    const byronAddr = RustModule.WalletV4.ByronAddress.from_address(address);
    if (byronAddr) {
      return {
        addressType: ADDRESS_TYPE.Byron,
        path: toDerivationPathString(path),
      };
    }
  }
  {
    const baseAddr = RustModule.WalletV4.BaseAddress.from_address(address);
    if (baseAddr) {
      const stakeCred = baseAddr.stake_cred();
      const hash = stakeCred.to_keyhash() ?? stakeCred.to_scripthash();
      if (hash == null) {
        throw new Error(`${nameof(toTrezorAddressParameters)} unknown hash type`);
      }
      return {
        addressType: ADDRESS_TYPE.Base,
        path: toDerivationPathString(path),
        stakingKeyHash: Buffer.from(hash.to_bytes()).toString('hex'),
      };
    }
  }
  {
    const ptrAddr = RustModule.WalletV4.PointerAddress.from_address(address);
    if (ptrAddr) {
      const pointer = ptrAddr.stake_ponter();
      return {
        addressType: ADDRESS_TYPE.Pointer,
        path: toDerivationPathString(path),
        certificatePointer: {
          blockIndex: pointer.slot(),
          txIndex: pointer.tx_index(),
          certificateIndex: pointer.cert_index(),
        },
      };
    }
  }
  {
    const enterpriseAddr = RustModule.WalletV4.EnterpriseAddress.from_address(address);
    if (enterpriseAddr) {
      return {
        addressType: ADDRESS_TYPE.Reward,
        path: toDerivationPathString(path),
      };
    }
  }
  {
    const rewardAddr = RustModule.WalletV4.RewardAddress.from_address(address);
    if (rewardAddr) {
      return {
        addressType: ADDRESS_TYPE.Enterprise,
        path: toDerivationPathString(path),
      };
    }
  }
  throw new Error(`${nameof(toTrezorAddressParameters)} unknown address type`);
}

// // ==================== LEDGER ==================== //
// /** Generate a payload for Ledger SignTx */
// export async function createLedgerSignTxPayload(
//   signRequest: BaseSignRequest<RustModule.WalletV4.TransactionBody>,
//   getTxsBodiesForUTXOs: TxBodiesFunc,
// ): Promise<LedgerSignTxPayload> {
//   const txJson = signRequest.unsignedTx.to_json();
//   // Map inputs to UNIQUE tx hashes (there might be multiple inputs from the same tx)
//   const txsHashes = [...new Set(txJson.inputs.map(x => x.id))];
//   const txsBodiesMap = await getTxsBodiesForUTXOs({ txsHashes });

//   const utxoMap = utxosToLookupMap(
//     signRequest.senderUtxos.map(utxo => ({
//       utxo_id: utxo.utxo_id,
//       tx_hash: utxo.tx_hash,
//       tx_index: utxo.tx_index,
//       receiver: utxo.receiver,
//       amount: utxo.amount,
//     }))
//   );

//   // Inputs
//   const ledgerInputs: Array<InputTypeUTxO> =
//     _transformToLedgerInputs(
//       txJson.inputs,
//       new Map(signRequest.senderUtxos.map(utxo => [
//         utxo.receiver,
//         { addressing: utxo.addressing },
//       ])),
//       utxoMap,
//       txsBodiesMap,
//     );

//   // Outputs
//   const ledgerOutputs: Array<OutputTypeAddress | OutputTypeChange> =
//     _transformToLedgerOutputs(
//       txJson.outputs,
//       signRequest.changeAddr,
//     );

//   return {
//     inputs: ledgerInputs,
//     outputs: ledgerOutputs,
//   };
// }

// function _transformToLedgerInputs(
//   inputs: Array<TxoPointerType>,
//   addressMap: Map<string, Addressing>,
//   utxoMap: UtxoLookupMap,
//   txDataHexMap: { [key: string]:string, ... }
// ): Array<InputTypeUTxO> {
//   return inputs.map(input => {
//     const utxo = utxoMap[input.id][input.index];
//     const addressingInfo = addressMap.get(utxo.receiver);
//     if (addressingInfo == null) throw new Error(`${nameof(_transformToLedgerInputs)} should never happen`);
//     verifyFromBip44Root(addressingInfo);
//     return {
//       txDataHex: txDataHexMap[input.id],
//       outputIndex: input.index,
//       path: addressingInfo.addressing.path,
//     };
//   });
// }

// function _transformToLedgerOutputs(
//   txOutputs: Array<TxOutType<number>>,
//   changeAddr: Array<{| ...Address, ...Value, ...Addressing |}>,
// ): Array<OutputTypeAddress | OutputTypeChange> {
//   return txOutputs.map(txOutput => {
//     const amountStr = txOutput.value.toString();
//     const change = changeAddr.find(addr => addr.address === txOutput.address);
//     if (change != null) {
//       verifyFromBip44Root({ addressing: change.addressing });
//       return {
//         path: change.addressing.path,
//         amountStr,
//       };
//     }

//     return {
//       address58: txOutput.address,
//       amountStr,
//     };
//   });
// }

// export async function prepareAndBroadcastLedgerSignedTx(
//   ledgerSignTxResp: LedgerSignTxResponse,
//   unsignedTx: RustModule.WalletV4.TransactionBody,
//   publicKey: RustModule.WalletV2.PublicKey,
//   keyLevel: number,
//   sendTx: SendFunc,
// ): Promise<PrepareAndBroadcastLedgerSignedTxResponse> {
//   try {
//     Logger.debug('hwTransactions::prepareAndBroadcastLedgerSignedTx: called');

//     const unsignedTxJson = unsignedTx.to_json();
//     Logger.debug(`hwTransactions::prepareAndBroadcastLedgerSignedTx unsignedTx: ${stringifyData(
//       unsignedTxJson
//     )}`);
//     const finalizer = new RustModule.WalletV4.TransactionBodyFinalized(unsignedTx);
//     ledgerSignTxResp.witnesses.map((witness) => prepareWitness(
//       finalizer,
//       witness,
//       publicKey,
//       keyLevel,
//     ));

//     const signedTx = finalizer.finalize();
//     const backendResponse = await sendTx({
//       id: signedTx.id(),
//       encodedTx: Buffer.from(signedTx.to_hex(), 'hex'),
//     });
//     Logger.debug('hwTransactions::prepareAndBroadcastLedgerSignedTx: success');

//     return backendResponse;
//   } catch (sendTxError) {
//     Logger.error('hwTransactions::prepareAndBroadcastLedgerSignedTx error: ' + stringifyError(sendTxError));
//     if (sendTxError instanceof InvalidWitnessError) {
//       throw new InvalidWitnessError();
//     } else {
//       throw new SendTransactionError();
//     }
//   }
// }

// function prepareWitness(
//   finalizer: RustModule.WalletV4.TransactionBodyFinalized,
//   ledgerWitness: Witness,
//   publicKey: RustModule.WalletV2.PublicKey,
//   keyLevel: number,
// ): void {
//   let finalKey = publicKey;
//   for (let i = keyLevel; i < ledgerWitness.path.length; i++) {
//     finalKey = finalKey.derive(
//       RustModule.WalletV2.DerivationScheme.v2(),
//       ledgerWitness.path[i]
//     );
//   }

//   const txSignature = RustModule.WalletV4.TransactionBodySignature.from_hex(
//     ledgerWitness.witnessSignatureHex
//   );

//   const witness = RustModule.WalletV2.Witness.from_external(finalKey, txSignature);
//   finalizer.add_witness(witness);
// }
