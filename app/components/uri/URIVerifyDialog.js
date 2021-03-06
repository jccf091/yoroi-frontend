// @flow
import type { Node } from 'react';
import React, { Component, } from 'react';
import classnames from 'classnames';
import { observer } from 'mobx-react';
import { defineMessages, intlShape } from 'react-intl';

import Dialog from '../widgets/Dialog';
import DialogCloseButton from '../widgets/DialogCloseButton';
import DialogBackButton from '../widgets/DialogBackButton';
import type { UriParams } from '../../utils/URIHandling';
import globalMessages from '../../i18n/global-messages';
import { formattedWalletAmount } from '../../utils/formatters';
import ExplorableHashContainer from '../../containers/widgets/ExplorableHashContainer';
import RawHash from '../widgets/hashWrappers/RawHash';
import type { UnitOfAccountSettingType } from '../../types/unitOfAccountType';
import { calculateAndFormatValue } from '../../utils/unit-of-account';
import type { $npm$ReactIntl$IntlFormat } from 'react-intl';
import { SelectedExplorer } from '../../domain/SelectedExplorer';

import styles from './URIVerifyDialog.scss';

const messages = defineMessages({
  uriVerifyTitle: {
    id: 'uri.verify.dialog.title',
    defaultMessage: '!!!Transaction details',
  },
  uriVerifyDialogAddressLabel: {
    id: 'uri.verify.dialog.address.label',
    defaultMessage: '!!!Receiver address',
  },
  uriVerifyDialogText: {
    id: 'uri.verify.dialog.text',
    defaultMessage: '!!!Before continuing, make sure the transaction details are correct.',
  },
});

type Props = {|
  +onSubmit: void => void,
  +onBack: void => void,
  +onCancel: void => void,
  +uriParams: UriParams,
  +selectedExplorer: SelectedExplorer,
  +meta: {|
    primaryTicker: string,
    decimalPlaces: number,
  |},
  +unitOfAccountSetting: UnitOfAccountSettingType,
  +coinPrice: ?number,
|};

@observer
export default class URIVerifyDialog extends Component<Props> {

  static contextTypes: {|intl: $npm$ReactIntl$IntlFormat|} = {
    intl: intlShape.isRequired,
  };

  render(): Node {
    const { onCancel, onSubmit, unitOfAccountSetting, coinPrice } = this.props;
    const { intl } = this.context;

    const dialogClasses = classnames([
      styles.dialog,
      'URIVerifyDialog'
    ]);

    const actions = [
      {
        label: intl.formatMessage(globalMessages.cancel),
        onClick: onCancel
      },
      {
        label: intl.formatMessage(globalMessages.continue),
        onClick: onSubmit,
        primary: true,
      },
    ];

    const amount = this.props.uriParams.amount;
    // TODO: in the future, we will need to confirm which wallet/account to use for this transaction
    return (
      <Dialog
        actions={actions}
        className={dialogClasses}
        title={intl.formatMessage(messages.uriVerifyTitle)}
        closeOnOverlayClick={false}
        closeButton={<DialogCloseButton />}
        onClose={onCancel}
        backButton={<DialogBackButton onBack={this.props.onBack} />}
      >
        <div>
          <h2 className={styles.label}>
            {intl.formatMessage(messages.uriVerifyDialogAddressLabel)}:
          </h2>
          <ExplorableHashContainer
            selectedExplorer={this.props.selectedExplorer}
            hash={this.props.uriParams.address}
            light
            linkType="address"
          >
            <RawHash light>
              <span className={styles.address}>{this.props.uriParams.address}</span>
            </RawHash>
          </ExplorableHashContainer>
        </div>
        <div>
          <h2 className={styles.label}>
            {intl.formatMessage(globalMessages.amountLabel)}:
          </h2>
          {unitOfAccountSetting.enabled ? (
            <>
              <div className={styles.amount}>
                {coinPrice != null ? calculateAndFormatValue(amount, coinPrice) : '-'}&nbsp;
                {unitOfAccountSetting.currency}
              </div>
              <div className={styles.amountSmall}>
                {formattedWalletAmount(
                  amount, this.props.meta.decimalPlaces
                )} {this.props.meta.primaryTicker}
              </div>
            </>
          ) : (
            <div className={styles.amount}>
              {formattedWalletAmount(
                amount, this.props.meta.decimalPlaces
              )} {this.props.meta.primaryTicker}
            </div>
          )}
        </div>
        <p className={styles.textBlock}>
          {intl.formatMessage(messages.uriVerifyDialogText)}
        </p>
      </Dialog>
    );
  }

}
