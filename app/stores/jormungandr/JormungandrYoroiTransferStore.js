// @flow
import { observable, } from 'mobx';
import Store from '../base/Store';
import Request from '../lib/LocalizedRequest';
import type {
  TransferTx,
} from '../../types/TransferTypes';
import { TransferSource, TransferKind, } from '../../types/TransferTypes';
import { v4Bip32PrivateToV3 } from '../../api/jormungandr/lib/crypto/utils';
import { yoroiTransferTxFromAddresses } from '../../api/jormungandr/lib/transactions/transfer/yoroiTransfer';
import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';
import { generateWalletRootKey, generateLedgerWalletRootKey, } from '../../api/ada/lib/cardanoCrypto/cryptoWallet';
import {
  HARD_DERIVATION_START,
  WalletTypePurpose,
  CoinTypes,
} from '../../config/numbersConfig';
import type { RestoreWalletForTransferResponse, RestoreWalletForTransferFunc } from '../../api/jormungandr/index';
import {
  Bip44DerivationLevels,
} from '../../api/ada/lib/storage/database/walletTypes/bip44/api/utils';
import {
  getJormungandrBaseConfig,
} from '../../api/ada/lib/storage/database/prepackaged/networks';

export default class JormungandrYoroiTransferStore extends Store {

  @observable restoreForTransferRequest: Request<RestoreWalletForTransferFunc>
    = new Request(this.api.jormungandr.restoreWalletForTransfer);

  _restoreWalletForTransfer: (string, number) => Promise<RestoreWalletForTransferResponse> = async (
    recoveryPhrase,
    accountIndex,
  ) => {
    const rootPk = this.stores.yoroiTransfer.transferKind === TransferKind.LEDGER
      ? generateLedgerWalletRootKey(recoveryPhrase)
      : generateWalletRootKey(recoveryPhrase);
    const stateFetcher = this.stores.substores.jormungandr.stateFetchStore.fetcher;

    if (this.stores.profile.selectedNetwork == null) {
      throw new Error(`${nameof(JormungandrYoroiTransferStore)}::${nameof(this.generateTransferTxFromMnemonic)} no network selected`);
    }
    const restoreResult = await this.restoreForTransferRequest.execute({
      network: this.stores.profile.selectedNetwork,
      rootPk: v4Bip32PrivateToV3(rootPk),
      accountIndex,
      checkAddressesInUse: stateFetcher.checkAddressesInUse,
      transferSource: this.stores.yoroiTransfer.transferSource,
    }).promise;
    if (!restoreResult) throw new Error('Restored wallet was not received correctly');
    return restoreResult;
  };

  generateTransferTxFromMnemonic: {|
    recoveryPhrase: string,
    updateStatusCallback: void => void,
    getDestinationAddress: void => Promise<string>,
  |} => Promise<TransferTx> = async (request) => {
    // 1) get receive address
    const destinationAddress = await request.getDestinationAddress();

    // 2) Perform restoration
    const accountIndex = 0 + HARD_DERIVATION_START;
    const { masterKey, addresses } = await this._restoreWalletForTransfer(
      request.recoveryPhrase,
      accountIndex,
    );

    request.updateStatusCallback();

    // 3) Calculate private keys for restored wallet utxo
    const accountKey = RustModule.WalletV3.Bip32PrivateKey
      .from_bytes(Buffer.from(masterKey, 'hex'))
      .derive(this.stores.yoroiTransfer.transferSource === TransferSource.CIP1852
        ? WalletTypePurpose.CIP1852
        : WalletTypePurpose.BIP44)
      .derive(CoinTypes.CARDANO)
      .derive(accountIndex);

    // 4) generate transaction

    if (this.stores.profile.selectedNetwork == null) {
      throw new Error(`${nameof(JormungandrYoroiTransferStore)}::${nameof(this.generateTransferTxFromMnemonic)} no network selected`);
    }
    const config = getJormungandrBaseConfig(
      this.stores.profile.selectedNetwork
    ).reduce((acc, next) => Object.assign(acc, next), {});

    const transferTx = await yoroiTransferTxFromAddresses({
      addresses,
      outputAddr: destinationAddress,
      keyLevel: Bip44DerivationLevels.ACCOUNT.level,
      signingKey: accountKey,
      getUTXOsForAddresses:
        this.stores.substores.jormungandr.stateFetchStore.fetcher.getUTXOsForAddresses,
      useLegacyWitness: this.stores.yoroiTransfer.transferSource === TransferSource.BIP44,
      genesisHash: config.ChainNetworkId,
      feeConfig: config.LinearFee,
    });
    // Possible exception: NotEnoughMoneyToSendError
    return transferTx;
  }
}
