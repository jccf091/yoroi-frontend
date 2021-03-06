// @flow
import React, { Component } from 'react';
import type { Node } from 'react';
import { intlShape } from 'react-intl';
import moment from 'moment';
import { observer } from 'mobx-react';
import BigNumber from 'bignumber.js';

import type { InjectedOrGenerated } from '../../../types/injectedPropsType';
import StakingDashboard from '../../../components/wallet/staking/dashboard/StakingDashboard';
import type { GraphData } from '../../../components/wallet/staking/dashboard/StakingDashboard';
import type { GraphItems, } from '../../../components/wallet/staking/dashboard/GraphWrapper';
import UserSummary from '../../../components/wallet/staking/dashboard/UserSummary';
import StakePool from '../../../components/wallet/staking/dashboard/StakePool';
import UndelegateDialog from '../../../components/wallet/staking/dashboard/UndelegateDialog';
import Dialog from '../../../components/widgets/Dialog';
import { getJormungandrTxFee } from '../../../api/jormungandr/lib/transactions/JormungandrTxSignRequest';
import DialogCloseButton from '../../../components/widgets/DialogCloseButton';
import ErrorBlock from '../../../components/widgets/ErrorBlock';
import InvalidURIImg from '../../../assets/images/uri/invalid-uri.inline.svg';
import UpcomingRewards from '../../../components/wallet/staking/dashboard/UpcomingRewards';
import type { BoxInfo } from '../../../components/wallet/staking/dashboard/UpcomingRewards';
import LessThanExpectedDialog from '../../../components/wallet/staking/dashboard/LessThanExpectedDialog';
import PoolWarningDialog from '../../../components/wallet/staking/dashboard/PoolWarningDialog';
import { digestForHash } from '../../../api/ada/lib/storage/database/primitives/api/utils';
import { handleExternalLinkClick } from '../../../utils/routing';
import LocalizableError from '../../../i18n/LocalizableError';
import UnmangleTxDialogContainer from '../../transfer/UnmangleTxDialogContainer';
import type { GeneratedData as UnmangleTxDialogContainerData } from '../../transfer/UnmangleTxDialogContainer';
import config from '../../../config';
import { formattedWalletAmount } from '../../../utils/formatters';
import type { PoolTuples, ReputationObject, } from '../../../api/jormungandr/lib/state-fetch/types';
import type { PoolMeta, DelegationRequests } from '../../../stores/toplevel/DelegationStore';
import EpochProgressContainer from './EpochProgressContainer';
import type { GeneratedData as EpochProgressContainerData } from './EpochProgressContainer';
import { PublicDeriver } from '../../../api/ada/lib/storage/models/PublicDeriver/index';
import { calculateAndFormatValue } from '../../../utils/unit-of-account';
import type { $npm$ReactIntl$IntlFormat } from 'react-intl';
import type { PoolRequest } from '../../../api/jormungandr/lib/storage/bridge/delegationUtils';
import { SelectedExplorer } from '../../../domain/SelectedExplorer';
import type {
  ToRealTimeFunc,
  ToAbsoluteSlotNumberFunc,
  TimeSinceGenesisFunc,
} from '../../../api/common/lib/storage/bridge/timeUtils';
import type { UnitOfAccountSettingType } from '../../../types/unitOfAccountType';
import type { CreateDelegationTxFunc } from '../../../api/jormungandr/index';
import type { CurrentTimeRequests, TimeCalcRequests } from '../../../stores/base/BaseCardanoTimeStore';
import type { TxRequests } from '../../../stores/toplevel/TransactionsStore';
import type { Notification } from '../../../types/notificationType';

import globalMessages from '../../../i18n/global-messages';
import { computed, observable, runInAction } from 'mobx';
import { ApiOptions, getApiForNetwork, getApiMeta } from '../../../api/common/utils';
import type { SelectedApiType, } from '../../../api/common/utils';
import { getUnmangleAmounts, } from '../../../stores/stateless/mangledAddresses';
import type { IAddressTypeStore, IAddressTypeUiSubset } from '../../../stores/stateless/addressStores';
import { GROUP_MANGLED } from '../../../stores/stateless/addressStores';
import type { NetworkRow } from '../../../api/ada/lib/storage/database/primitives/tables';
import { isJormungandr } from '../../../api/ada/lib/storage/database/prepackaged/networks';

export type GeneratedData = typeof StakingDashboardPage.prototype.generated;

type Props = InjectedOrGenerated<GeneratedData>;

@observer
export default class StakingDashboardPage extends Component<Props> {
  static contextTypes: {|intl: $npm$ReactIntl$IntlFormat|} = {
    intl: intlShape.isRequired,
  };

  @observable notificationElementId: string = '';

  async componentDidMount() {
    const timeStore = this.generated.stores.time;
    const publicDeriver = this.generated.stores.wallets.selected;
    if (publicDeriver == null) {
      throw new Error(`${nameof(StakingDashboardPage)} no public deriver. Should never happen`);
    }
    const timeCalcRequests = timeStore.getTimeCalcRequests(publicDeriver);
    await timeCalcRequests.requests.toAbsoluteSlot.execute().promise;
    await timeCalcRequests.requests.toRealTime.execute().promise;
    await timeCalcRequests.requests.currentEpochLength.execute().promise;
    await timeCalcRequests.requests.currentSlotLength.execute().promise;
  }

  componentWillUnmount() {
    this.generated.actions.jormungandr.delegationTransaction.reset.trigger();
    this.generated.actions.ada.delegationTransaction.reset.trigger();
  }

  hideOrFormat: (BigNumber, $PropertyType<SelectedApiType, 'meta'>) => {|
    +ADA: string,
    +unitOfAccount: void | {| currency: string, amount: string |},
  |} = (amount, apiMeta) => {
    if (this.generated.stores.profile.shouldHideBalance) {
      return {
        ADA: '******',
        unitOfAccount: undefined,
      };
    }

    const coinPrice: ?number = this.generated.stores.profile.unitOfAccount.enabled
      ? (
        this.generated.stores.coinPriceStore.getCurrentPrice(
          apiMeta.primaryTicker,
          this.generated.stores.profile.unitOfAccount.currency
        )
      )
      : null;

    const unitOfAccount =
      coinPrice == null
      || this.generated.stores.profile.unitOfAccount.currency == null
        ? undefined
        : {
          currency: this.generated.stores.profile.unitOfAccount.currency,
          amount: calculateAndFormatValue(
            new BigNumber(amount),
            coinPrice
          )
        };
    return {
      ADA: formattedWalletAmount(amount, apiMeta.decimalPlaces.toNumber()),
      unitOfAccount,
    };
  };

  render(): Node {
    const publicDeriver = this.generated.stores.wallets.selected;
    if (publicDeriver == null) {
      throw new Error(`${nameof(StakingDashboardPage)} no public deriver. Should never happen`);
    }

    const delegationStore = this.generated.stores.delegation;
    const delegationRequests = delegationStore.getDelegationRequests(publicDeriver);
    if (delegationRequests == null) {
      throw new Error(`${nameof(StakingDashboardPage)} opened for non-reward wallet`);
    }

    const rewardInfo = this.getRewardInfo(publicDeriver);

    const errorIfPresent = this.getErrorInFetch(publicDeriver);
    const stakePools = errorIfPresent == null
      ? this.getStakePools(publicDeriver)
      : errorIfPresent;

    const { getThemeVars } = this.generated.stores.profile;

    const dashboard = (
      <StakingDashboard
        pageInfo={
          !delegationRequests.getCurrentDelegation.wasExecuted ||
          delegationRequests.getCurrentDelegation.isExecuting
            ? undefined
            : {
              currentPage: this.generated.stores.delegation.selectedPage,
              numPages: Array.from(new Set(
                delegationRequests.getCurrentDelegation.result?.currEpoch?.pools.map(
                  tuple => tuple[0]
                )
              ) ?? []).length,
              goToPage: page => this.generated.actions.delegation.setSelectedPage.trigger(page),
            }}
        hasAnyPending={this.generated.stores.transactions.hasAnyPending}
        themeVars={getThemeVars({ theme: 'YoroiModern' })}
        stakePools={stakePools}
        epochProgress={<EpochProgressContainer
          {...this.generated.EpochProgressContainerProps}
          publicDeriver={publicDeriver}
          showTooltip={rewardInfo != null && rewardInfo.showWarning}
        />}
        userSummary={this._generateUserSummary({
          delegationRequests,
          publicDeriver,
          errorIfPresent,
        })}
        upcomingRewards={rewardInfo?.rewardPopup}
        graphData={this._generateGraphData({
          delegationRequests,
          publicDeriver,
        })}
        delegationHistory={delegationRequests.getCurrentDelegation.result?.fullHistory}
        epochLength={this.getEpochLengthInDays(publicDeriver)}
      />
    );

    const popup = this.generatePopupDialog(publicDeriver);
    return (
      <>
        {popup}
        {this.getDialog()}
        {dashboard}
      </>);
  }

  getEpochLengthInDays: PublicDeriver<> => ?number = (publicDeriver) => {
    const timeStore = this.generated.stores.time;
    const timeCalcRequests = timeStore.getTimeCalcRequests(publicDeriver);
    const getEpochLength = timeCalcRequests.requests.currentEpochLength.result;
    if (getEpochLength == null) return null;

    const getSlotLength = timeCalcRequests.requests.currentSlotLength.result;
    if (getSlotLength == null) return null;

    const epochLengthInSeconds = getEpochLength() * getSlotLength();
    const epochLengthInDays = epochLengthInSeconds / (60 * 60 * 24);
    return epochLengthInDays;
  }

  generatePopupDialog: PublicDeriver<> => (null | Node) = (publicDeriver) => {
    if (!isJormungandr(publicDeriver.getParent().getNetworkInfo())) {
      return null; // TODO
    }
    const apiMeta = getApiMeta(
      getApiForNetwork(publicDeriver.getParent().getNetworkInfo())
    )?.meta;
    if (apiMeta == null) throw new Error(`${nameof(StakingDashboardPage)} no API selected`);

    const { uiDialogs } = this.generated.stores;
    const delegationTxStore = this.generated.stores.substores.jormungandr
      .delegationTransaction;

    const cancel = () => {
      this.generated.actions.dialogs.closeActiveDialog.trigger();
      this.generated.actions.jormungandr.delegationTransaction.reset.trigger();
    };
    if (delegationTxStore.createDelegationTx.error != null) {
      const { intl } = this.context;

      return (
        <Dialog
          title={intl.formatMessage(globalMessages.errorLabel)}
          closeOnOverlayClick={false}
          onClose={cancel}
          closeButton={<DialogCloseButton onClose={cancel} />}
          actions={[{
            label: intl.formatMessage(globalMessages.backButtonLabel),
            onClick: cancel,
            primary: true,
          }]}
        >
          <>
            <center><InvalidURIImg /></center>
            <ErrorBlock
              error={delegationTxStore.createDelegationTx.error}
            />
          </>
        </Dialog>
      );
    }

    if (!uiDialogs.isOpen(UndelegateDialog)) {
      return null;
    }
    const delegationTx = delegationTxStore.createDelegationTx.result;
    if (delegationTx == null) {
      return null;
    }

    return (<UndelegateDialog
      onCancel={cancel}
      classicTheme={this.generated.stores.profile.isClassicTheme}
      error={delegationTxStore.signAndBroadcastDelegationTx.error}
      onSubmit={async request => {
        await this.generated.actions.jormungandr
          .delegationTransaction
          .signTransaction
          .trigger({ password: request.password, publicDeriver, });
        cancel();
      }}
      generatingTx={
        this.generated.stores.substores.jormungandr
          .delegationTransaction
          .createDelegationTx
          .isExecuting
      }
      isSubmitting={delegationTxStore.signAndBroadcastDelegationTx.isExecuting}
      transactionFee={getJormungandrTxFee(delegationTx.unsignedTx.IOs, true)}
      staleTx={delegationTxStore.isStale}
      decimalPlaces={apiMeta.decimalPlaces.toNumber()}
    />);
  }

  getRewardInfo: PublicDeriver<> => (void | {|
    rewardPopup: Node,
    showWarning: boolean,
  |}) = (publicDeriver) => {
    const timeStore = this.generated.stores.time;
    const timeCalcRequests = timeStore.getTimeCalcRequests(publicDeriver);
    const currTimeRequests = timeStore.getCurrentTimeRequests(publicDeriver);
    const toAbsoluteSlot = timeCalcRequests.requests.toAbsoluteSlot.result;
    if (toAbsoluteSlot == null) return undefined;
    const toRealTime = timeCalcRequests.requests.toRealTime.result;
    if (toRealTime == null) return undefined;
    const timeSinceGenesis = timeCalcRequests.requests.timeSinceGenesis.result;
    if (timeSinceGenesis == null) return undefined;

    const delegationStore = this.generated.stores.delegation;
    const delegationRequests = delegationStore.getDelegationRequests(publicDeriver);
    if (delegationRequests == null) {
      throw new Error(`${nameof(StakingDashboardPage)} opened for non-reward wallet`);
    }
    let rewardInfo = undefined;
    if (!(
      !delegationRequests.getCurrentDelegation.wasExecuted ||
      delegationRequests.getCurrentDelegation.isExecuting
    )) {
      const { result } = delegationRequests.getCurrentDelegation;
      if (result == null || result.currEpoch == null) {
        rewardInfo = {
          rewardPopup: (
            <UpcomingRewards
              content={[
                this.generateUpcomingRewardInfo({
                  epoch: currTimeRequests.currentEpoch + 1,
                  pools: [],
                  toAbsoluteSlot,
                  toRealTime,
                  timeSinceGenesis,
                }),
                this.generateUpcomingRewardInfo({
                  epoch: currTimeRequests.currentEpoch + 2,
                  pools: [],
                  toAbsoluteSlot,
                  toRealTime,
                  timeSinceGenesis,
                }),
                this.generateUpcomingRewardInfo({
                  epoch: currTimeRequests.currentEpoch + 3,
                  pools: [],
                  toAbsoluteSlot,
                  toRealTime,
                  timeSinceGenesis,
                }),
              ]}
              showWarning={false}
              onExternalLinkClick={handleExternalLinkClick}
              baseUrl=""
            />
          ),
          showWarning: false,
        };
      } else {
        const currEpochCert = result.currEpoch;

        // first reward is slower than the rest
        // it takes 2 epochs for stake delegation to update
        // then after the start of the 3rd epoch, you get the reward
        const upcomingRewards: Array<BoxInfo> = [];
        for (let i = 4; i >= 2; i--) {
          upcomingRewards.unshift(this.generateUpcomingRewardInfo({
            epoch: currTimeRequests.currentEpoch + i + 1,
            pools: currEpochCert.pools,
            toAbsoluteSlot,
            toRealTime,
            timeSinceGenesis,
          }));
        }
        if (result.prevEpoch) {
          upcomingRewards.unshift(this.generateUpcomingRewardInfo({
            epoch: currTimeRequests.currentEpoch + 2,
            pools: result.prevEpoch.pools,
            toAbsoluteSlot,
            toRealTime,
            timeSinceGenesis,
          }));
        }
        if (result.prevPrevEpoch) {
          upcomingRewards.unshift(this.generateUpcomingRewardInfo({
            epoch: currTimeRequests.currentEpoch + 1,
            pools: result.prevPrevEpoch.pools,
            toAbsoluteSlot,
            toRealTime,
            timeSinceGenesis,
          }));
        }

        const poolExplorerLink = this.generated.stores.explorers.selectedExplorer
          .get(publicDeriver.getParent().getNetworkInfo().NetworkId)
          ?.getOrDefault('pool') ?? (() => { throw new Error('No explorer for wallet network'); })();

        const upcomingTuples = ((upcomingRewards.slice(0, 3): any): [?BoxInfo, ?BoxInfo, ?BoxInfo]);
        const rewardPopup = (
          <UpcomingRewards
            content={upcomingTuples}
            showWarning={upcomingRewards.length === 3}
            onExternalLinkClick={handleExternalLinkClick}
            baseUrl={poolExplorerLink.baseUrl}
          />
        );
        rewardInfo = {
          rewardPopup,
          showWarning: upcomingRewards.length === 3,
        };
      }
    }

    return rewardInfo ?? ({
      rewardPopup: (
        <UpcomingRewards
          content={[null, null, null]}
          showWarning={false}
          onExternalLinkClick={handleExternalLinkClick}
          baseUrl=""
        />
      ),
      showWarning: false,
    });
  }

  generateUpcomingRewardInfo: {|
    epoch: number,
    pools: Array<PoolTuples>,
    toRealTime: ToRealTimeFunc,
    toAbsoluteSlot: ToAbsoluteSlotNumberFunc,
    timeSinceGenesis: TimeSinceGenesisFunc,
  |} => BoxInfo = (request) => {

    const endEpochTime = request.toRealTime({
      absoluteSlotNum: request.toAbsoluteSlot({
        epoch: request.epoch,
        slot: 0,
      }),
      timeSinceGenesisFunc: request.timeSinceGenesis,
    });
    const endEpochMoment = moment(endEpochTime);
    return {
      pools: request.pools,
      epoch: request.epoch,
      time: [
        endEpochMoment.format('MMM Do'),
        endEpochMoment.format('hh'),
        endEpochMoment.format('mm'),
        endEpochMoment.format('ss'),
        endEpochMoment.format('A'),
      ],
    };
  }

  getErrorInFetch: PublicDeriver<> => void | {| error: LocalizableError, |} = (
    publicDeriver
  ) => {
    const delegationStore = this.generated.stores.delegation;
    const delegationRequests = delegationStore.getDelegationRequests(publicDeriver);
    if (delegationRequests == null) {
      throw new Error(`${nameof(StakingDashboardPage)} opened for non-reward wallet`);
    }
    if (delegationRequests.error != null) {
      return { error: delegationRequests.error };
    }
    if (delegationRequests.getCurrentDelegation.result != null) {
      const currentDelegation = delegationRequests.getCurrentDelegation.result;
      const currEpochInfo = currentDelegation.currEpoch;
      if (currEpochInfo == null) {
        return undefined;
      }
    }
    return undefined;
  }

  getStakePools: PublicDeriver<> => {| pools: null | Array<Node | void> |} = (
    publicDeriver
  ) => {
    const delegationStore = this.generated.stores.delegation;
    const delegationRequests = delegationStore.getDelegationRequests(publicDeriver);
    if (delegationRequests == null) {
      throw new Error(`${nameof(StakingDashboardPage)} opened for non-reward wallet`);
    }
    if (
      !delegationRequests.getCurrentDelegation.wasExecuted ||
      delegationRequests.getCurrentDelegation.isExecuting ||
      delegationRequests.getCurrentDelegation.result == null
    ) {
      return { pools: null };
    }
    if (delegationRequests.getCurrentDelegation.result.currEpoch == null) {
      return { pools: [] };
    }
    const currentPools = delegationRequests.getCurrentDelegation.result.currEpoch.pools;

    const tooltipNotification = {
      duration: config.wallets.ADDRESS_COPY_TOOLTIP_NOTIFICATION_DURATION,
      message: globalMessages.copyTooltipMessage,
    };

    const { uiNotifications, } = this.generated.stores;
    const { intl } = this.context;
    return {
      pools: currentPools.map(pool => {
        const meta = this.generated.stores.delegation.getLocalPoolInfo(
          publicDeriver.getParent().getNetworkInfo(),
          pool[0],
        );
        if (meta == null) {
          // server hasn't returned information about the stake pool yet
          return undefined;
        }
        const name = meta.info?.name ?? intl.formatMessage(globalMessages.unknownPoolLabel);

        const moreInfo = meta.info?.homepage != null
          ? {
            openPoolPage: handleExternalLinkClick,
            url: meta.info.homepage,
          }
          : undefined;

        // TODO: implement this eventually
        const stakePoolMeta = {
          // percentage: '30',
          // fullness: '18',
          // margins: '12',
          // created: '29/02/2019 12:42:41 PM',
          // cost: '12,688.00000',
          // stake: '9,688.00000',
          // pledge: '85.567088',
          // rewards: '81.000088',
          // age: '23',
        };
        return (
          <StakePool
            purpose="dashboard"
            poolName={name}
            key={digestForHash(JSON.stringify(meta), 0)}
            data={stakePoolMeta}
            selectedExplorer={this.generated.stores.explorers.selectedExplorer.get(
              publicDeriver.getParent().getNetworkInfo().NetworkId
            ) ?? (() => { throw new Error('No explorer for wallet network'); })()}
            hash={pool[0]}
            moreInfo={moreInfo}
            classicTheme={this.generated.stores.profile.isClassicTheme}
            onCopyAddressTooltip={(address, elementId) => {
              if (!uiNotifications.isOpen(elementId)) {
                runInAction(() => {
                  this.notificationElementId = elementId;
                });
                this.generated.actions.notifications.open.trigger({
                  id: elementId,
                  duration: tooltipNotification.duration,
                  message: tooltipNotification.message,
                });
              }
            }}
            notification={this.notificationElementId == null
              ? null
              : uiNotifications.getTooltipActiveNotification(
                this.notificationElementId
              )
            }
            undelegate={
              // don't support undelegation for ratio stake since it's a less intuitive UX
              currentPools.length === 1 && isJormungandr(publicDeriver.getParent().getNetworkInfo())
                ? async () => {
                  this.generated.actions.dialogs.open.trigger({ dialog: UndelegateDialog });
                  await this.generated.actions.jormungandr
                    .delegationTransaction
                    .createTransaction
                    .trigger({
                      publicDeriver,
                      poolRequest: undefined,
                    });
                }
                : undefined
            }
            reputationInfo={meta.reputation}
            openReputationDialog={() => this.generated.actions.dialogs.open.trigger({
              dialog: PoolWarningDialog,
              params: { reputation: meta.reputation },
            })}
          />
        );
      })
    };
  }

  getDialog: void => Node = () => {
    const uiDialogs = this.generated.stores.uiDialogs;

    if (uiDialogs.isOpen(LessThanExpectedDialog)) {
      return (
        <LessThanExpectedDialog
          close={() => this.generated.actions.dialogs.closeActiveDialog.trigger()}
        />
      );
    }

    if (uiDialogs.isOpen(PoolWarningDialog)) {
      return (
        <PoolWarningDialog
          close={() => this.generated.actions.dialogs.closeActiveDialog.trigger()}
          reputationInfo={uiDialogs.getParam<ReputationObject>('reputation')}
        />
      );
    }

    if (uiDialogs.isOpen(UnmangleTxDialogContainer)) {
      return (
        <UnmangleTxDialogContainer
          {...this.generated.UnmangleTxDialogContainerProps}
          onClose={() => this.generated.actions.dialogs.closeActiveDialog.trigger()}
        />
      );
    }

    return null;
  }

  _generateUserSummary: {|
    delegationRequests: DelegationRequests,
    publicDeriver: PublicDeriver<>,
    errorIfPresent: void | {| error: LocalizableError |}
  |} => Node = (request) => {
    const showRewardAmount = request.delegationRequests.getCurrentDelegation.wasExecuted &&
      request.delegationRequests.getDelegatedBalance.wasExecuted &&
      request.errorIfPresent == null;

    const mangledAddrRequest = this.generated.stores.addresses.addressSubgroupMap.get(
      GROUP_MANGLED.class
    );
    if (mangledAddrRequest == null) throw new Error('No request. Should never happen');
    const {
      canUnmangle,
      cannotUnmangle,
    } = getUnmangleAmounts(mangledAddrRequest.all);

    const canUnmangleSum = canUnmangle.reduce(
      (sum, val) => sum.plus(val),
      new BigNumber(0)
    );
    const cannotUnmangleSum = cannotUnmangle.reduce(
      (sum, val) => sum.plus(val),
      new BigNumber(0)
    );

    const txRequests = this.generated.stores.transactions
      .getTxRequests(request.publicDeriver);
    const balance = txRequests.requests.getBalanceRequest.result;

    const apiMeta = getApiMeta(
      getApiForNetwork(request.publicDeriver.getParent().getNetworkInfo())
    )?.meta;
    if (apiMeta == null) throw new Error(`${nameof(StakingDashboardPage)} no API selected`);
    const amountPerUnit = new BigNumber(10).pow(apiMeta.decimalPlaces);

    return (
      <UserSummary
        meta={{
          decimalPlaces: apiMeta.decimalPlaces.toNumber(),
          primaryTicker: apiMeta.primaryTicker,
        }}
        canUnmangleSum={canUnmangleSum}
        cannotUnmangleSum={cannotUnmangleSum}
        onUnmangle={() => this.generated.actions.dialogs.open.trigger({
          dialog: UnmangleTxDialogContainer,
        })}
        totalAdaSum={balance == null
          ? undefined
          : this.hideOrFormat(balance.dividedBy(amountPerUnit), apiMeta)
        }
        totalRewards={
          !showRewardAmount || request.delegationRequests.getDelegatedBalance.result == null
            ? undefined
            : this.hideOrFormat(
              request.delegationRequests.getDelegatedBalance.result
                .accountPart
                .dividedBy(amountPerUnit),
              apiMeta
            )
        }
        openLearnMore={() => this.generated.actions.dialogs.open.trigger({
          dialog: LessThanExpectedDialog,
        })}
        totalDelegated={
          !showRewardAmount || request.delegationRequests.getDelegatedBalance.result == null
            ? undefined
            : this.hideOrFormat(
              request.delegationRequests.getDelegatedBalance.result.utxoPart.plus(
                request.delegationRequests.getDelegatedBalance.result.accountPart
              ).dividedBy(amountPerUnit),
              apiMeta
            )}
      />
    );
  }

  _generateRewardGraphData: {|
    delegationRequests: DelegationRequests,
    currentEpoch: number,
    publicDeriver: PublicDeriver<>,
  |} => (?{|
    totalRewards: Array<GraphItems>,
    perEpochRewards: Array<GraphItems>,
  |}) = (
    request
  ) => {
    const apiMeta = getApiMeta(
      getApiForNetwork(request.publicDeriver.getParent().getNetworkInfo())
    )?.meta;
    if (apiMeta == null) throw new Error(`${nameof(StakingDashboardPage)} no API selected`);
    const amountPerUnit = new BigNumber(10).pow(apiMeta.decimalPlaces);

    const history = request.delegationRequests.rewardHistory.result;
    if (history == null) {
      return null;
    }
    if (!request.delegationRequests.getCurrentDelegation.wasExecuted) {
      return null;
    }
    let historyIterator = 0;

    // the reward history endpoint doesn't contain entries when the reward was 0
    // so we need to insert these manually
    const totalRewards: Array<GraphItems> = [];
    const perEpochRewards: Array<GraphItems> = [];
    let adaSum = new BigNumber(0);
    // note: reward history includes the current epoch
    // since it tells you the reward you got at slot 0 of the new epoch
    for (let i = 0; i <= request.currentEpoch; i++) {
      if (historyIterator < history.length && i === history[historyIterator][0]) {
        // exists a reward for this epoch
        const nextReward = history[historyIterator][1];
        adaSum = adaSum.plus(nextReward);
        totalRewards.push({
          name: i,
          primary: adaSum.dividedBy(amountPerUnit).toNumber(),
        });
        perEpochRewards.push({
          name: i,
          primary: nextReward / amountPerUnit.toNumber(),
        });
        historyIterator++;
      } else {
        // no reward for this epoch
        totalRewards.push({
          name: i,
          primary: adaSum.dividedBy(amountPerUnit).toNumber(),
        });
        perEpochRewards.push({
          name: i,
          primary: 0,
        });
      }
    }
    return {
      totalRewards,
      perEpochRewards,
    };
  }

  _generateGraphData: {|
    delegationRequests: DelegationRequests,
    publicDeriver: PublicDeriver<>,
  |} => GraphData = (request) => {
    const timeStore = this.generated.stores.time;
    const currTimeRequests = timeStore.getCurrentTimeRequests(request.publicDeriver);

    return {
      rewardsGraphData: {
        error: request.delegationRequests.rewardHistory.error,
        items: this._generateRewardGraphData({
          delegationRequests: request.delegationRequests,
          currentEpoch: currTimeRequests.currentEpoch,
          publicDeriver: request.publicDeriver,
        }),
        hideYAxis: this.generated.stores.profile.shouldHideBalance
      }
    };
  }

  @computed get generated(): {|
    EpochProgressContainerProps: InjectedOrGenerated<EpochProgressContainerData>,
    UnmangleTxDialogContainerProps: InjectedOrGenerated<UnmangleTxDialogContainerData>,
    actions: {|
      ada: {|
        delegationTransaction: {|
          reset: {| trigger: (params: void) => void |},
        |},
      |},
      jormungandr: {|
        delegationTransaction: {|
          createTransaction: {|
            trigger: (params: {|
              poolRequest: PoolRequest,
              publicDeriver: PublicDeriver<>
            |}) => Promise<void>
          |},
          reset: {| trigger: (params: void) => void |},
          signTransaction: {|
            trigger: (params: {|
              password: string,
              publicDeriver: PublicDeriver<>
            |}) => Promise<void>
          |}
        |}
      |},
      delegation: {|
        setSelectedPage: {|
          trigger: (params: number) => void
        |},
      |},
      dialogs: {|
        closeActiveDialog: {|
          trigger: (params: void) => void
        |},
        open: {|
          trigger: (params: {|
            dialog: any,
            params?: any
          |}) => void
        |}
      |},
      notifications: {|
        open: {| trigger: (params: Notification) => void |}
      |}
    |},
    stores: {|
      addresses: {|
        addressSubgroupMap: $ReadOnlyMap<Class<IAddressTypeStore>, IAddressTypeUiSubset>,
      |},
      coinPriceStore: {|
        getCurrentPrice: (from: string, to: string) => ?number
      |},
      explorers: {|
        selectedExplorer: Map<number, SelectedExplorer>,
      |},
      profile: {|
        getThemeVars: ({| theme: string |}) => {
          [key: string]: string,
          ...
        },
        isClassicTheme: boolean,
        shouldHideBalance: boolean,
        unitOfAccount: UnitOfAccountSettingType
      |},
      delegation: {|
        selectedPage: number,
        getLocalPoolInfo: ($ReadOnly<NetworkRow>, string) => (void | PoolMeta),
        getDelegationRequests: (
          PublicDeriver<>
        ) => void | DelegationRequests,
      |},
      time: {|
        getCurrentTimeRequests: (
          PublicDeriver<>
        ) => CurrentTimeRequests,
        getTimeCalcRequests: (
          PublicDeriver<>
        ) => TimeCalcRequests
      |},
      substores: {|
        jormungandr: {|
          delegationTransaction: {|
            createDelegationTx: {|
              error: ?LocalizableError,
              isExecuting: boolean,
              result: ?PromisslessReturnType<CreateDelegationTxFunc>
            |},
            isStale: boolean,
            signAndBroadcastDelegationTx: {|
              error: ?LocalizableError,
              isExecuting: boolean
            |}
          |},
        |}
      |},
      transactions: {|
        getTxRequests: (PublicDeriver<>) => TxRequests,
        hasAnyPending: boolean
      |},
      uiDialogs: {|
        getParam: <T>(number | string) => T,
        isOpen: any => boolean
      |},
      uiNotifications: {|
        getTooltipActiveNotification: string => ?Notification,
        isOpen: string => boolean
      |},
      wallets: {| selected: null | PublicDeriver<> |}
    |}
    |} {
    if (this.props.generated !== undefined) {
      return this.props.generated;
    }
    if (this.props.stores == null || this.props.actions == null) {
      throw new Error(`${nameof(StakingDashboardPage)} no way to generated props`);
    }
    const { stores, actions } = this.props;
    const jormungandrStore = stores.substores.jormungandr;

    const selected = stores.wallets.selected;
    if (selected == null) {
      throw new Error(`${nameof(EpochProgressContainer)} no wallet selected`);
    }
    const api = getApiForNetwork(selected.getParent().getNetworkInfo());
    const time = (() => {
      if (api === ApiOptions.ada) {
        return {
          getTimeCalcRequests: stores.substores.ada.time.getTimeCalcRequests,
          getCurrentTimeRequests: stores.substores.ada.time.getCurrentTimeRequests,
        };
      }
      if (api === ApiOptions.jormungandr) {
        return {
          getTimeCalcRequests: stores.substores.jormungandr.time.getTimeCalcRequests,
          getCurrentTimeRequests: stores.substores.jormungandr.time.getCurrentTimeRequests,
        };
      }
      throw new Error(`${nameof(EpochProgressContainer)} api not supported`);
    })();
    return Object.freeze({
      stores: {
        explorers: {
          selectedExplorer: stores.explorers.selectedExplorer,
        },
        profile: {
          isClassicTheme: stores.profile.isClassicTheme,
          shouldHideBalance: stores.profile.shouldHideBalance,
          getThemeVars: stores.profile.getThemeVars,
          unitOfAccount: stores.profile.unitOfAccount,
        },
        addresses: {
          addressSubgroupMap: stores.addresses.addressSubgroupMap,
        },
        wallets: {
          selected: stores.wallets.selected,
        },
        coinPriceStore: {
          getCurrentPrice: stores.coinPriceStore.getCurrentPrice,
        },
        uiDialogs: {
          isOpen: stores.uiDialogs.isOpen,
          getParam: stores.uiDialogs.getParam,
        },
        uiNotifications: {
          isOpen: stores.uiNotifications.isOpen,
          getTooltipActiveNotification: stores.uiNotifications.getTooltipActiveNotification,
        },
        transactions: {
          hasAnyPending: stores.transactions.hasAnyPending,
          getTxRequests: stores.transactions.getTxRequests,
        },
        delegation: {
          selectedPage: stores.delegation.selectedPage,
          getLocalPoolInfo: stores.delegation.getLocalPoolInfo,
          getDelegationRequests: stores.delegation.getDelegationRequests,
        },
        time,
        substores: {
          jormungandr: {
            delegationTransaction: {
              isStale: jormungandrStore.delegationTransaction.isStale,
              createDelegationTx: {
                isExecuting: jormungandrStore.delegationTransaction.createDelegationTx.isExecuting,
                error: jormungandrStore.delegationTransaction.createDelegationTx.error,
                result: jormungandrStore.delegationTransaction.createDelegationTx.result,
              },
              signAndBroadcastDelegationTx: {
                error: jormungandrStore.delegationTransaction.signAndBroadcastDelegationTx.error,
                isExecuting:
                  jormungandrStore.delegationTransaction.signAndBroadcastDelegationTx.isExecuting,
              },
            },
          },
        },
      },
      actions: {
        dialogs: {
          closeActiveDialog: {
            trigger: actions.dialogs.closeActiveDialog.trigger,
          },
          open: {
            trigger: actions.dialogs.open.trigger,
          },
        },
        notifications: {
          open: {
            trigger: actions.notifications.open.trigger,
          },
        },
        delegation: {
          setSelectedPage: {
            trigger: actions.delegation.setSelectedPage.trigger,
          },
        },
        ada: {
          delegationTransaction: {
            reset: {
              trigger: actions.jormungandr.delegationTransaction.reset.trigger,
            },
          },
        },
        jormungandr: {
          delegationTransaction: {
            reset: {
              trigger: actions.jormungandr.delegationTransaction.reset.trigger,
            },
            signTransaction: {
              trigger: actions.jormungandr.delegationTransaction.signTransaction.trigger,
            },
            createTransaction: {
              trigger: actions.jormungandr.delegationTransaction.createTransaction.trigger,
            },
          },
        },
      },
      EpochProgressContainerProps: (
        { stores, actions }: InjectedOrGenerated<EpochProgressContainerData>
      ),
      UnmangleTxDialogContainerProps: (
        { stores, actions }: InjectedOrGenerated<UnmangleTxDialogContainerData>
      ),
    });
  }
}
