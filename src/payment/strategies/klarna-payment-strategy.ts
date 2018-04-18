/// <reference path="../../remote-checkout/methods/klarna/klarna-sdk.d.ts" />

import { omit } from 'lodash';

import { CheckoutSelectors, CheckoutStore } from '../../checkout';
import { MissingDataError, NotInitializedError } from '../../common/error/errors';
import { OrderRequestBody, PlaceOrderService } from '../../order';
import { RemoteCheckoutActionCreator } from '../../remote-checkout';
import { KlarnaScriptLoader } from '../../remote-checkout/methods/klarna';
import Payment from '../payment';
import PaymentMethod from '../payment-method';

import PaymentStrategy from './payment-strategy';

export default class KlarnaPaymentStrategy extends PaymentStrategy {
    private _klarnaSdk?: Klarna.Sdk;
    private _unsubscribe?: (() => void);

    constructor(
        store: CheckoutStore,
        placeOrderService: PlaceOrderService,
        private _remoteCheckoutActionCreator: RemoteCheckoutActionCreator,
        private _klarnaScriptLoader: KlarnaScriptLoader
    ) {
        super(store, placeOrderService);
    }

    initialize(options: InitializeOptions): Promise<CheckoutSelectors> {
        return this._klarnaScriptLoader.load()
            .then(klarnaSdk => { this._klarnaSdk = klarnaSdk; })
            .then(() => {
                this._unsubscribe = this._store.subscribe(
                    () => this._loadWidget(options),
                    ({ checkout }) => {
                        const cart = checkout.getCart();

                        return cart && cart.grandTotal;
                    }
                );

                return this._loadWidget(options);
            })
            .then(() => super.initialize(options));
    }

    deinitialize(options: any): Promise<CheckoutSelectors> {
        if (this._unsubscribe) {
            this._unsubscribe();
        }

        return super.deinitialize(options);
    }

    execute(payload: OrderRequestBody, options?: any): Promise<CheckoutSelectors> {
        return this._authorize()
            .then((res: Klarna.AuthorizationResponse) => {
                const authorizationToken = res.authorization_token;

                return this._store.dispatch(
                    this._remoteCheckoutActionCreator.initializePayment(payload.payment.name, { authorizationToken })
                );
            })
            .then(() => {
                return this._placeOrderService.submitOrder({
                    ...payload,
                    payment: omit(payload.payment, 'paymentData') as Payment,
                    // Note: API currently doesn't support using Store Credit with Klarna.
                    // To prevent deducting customer's store credit, set it as false.
                    useStoreCredit: false,
                }, options);
            });
    }

    private _loadWidget(options: InitializeOptions): Promise<CheckoutSelectors> {
        const { container, loadCallback } = options;
        const { id: paymentId } = options.paymentMethod;

        return this._placeOrderService.loadPaymentMethod(paymentId)
            .then(({ checkout }: CheckoutSelectors) => {
                const paymentMethod = checkout.getPaymentMethod(paymentId);

                if (!paymentMethod || !paymentMethod.clientToken) {
                    throw new MissingDataError('Unable to load payment widget because "paymentMethod.clientToken" field is missing.');
                }

                if (!this._klarnaSdk) {
                    throw new NotInitializedError();
                }

                this._klarnaSdk.init({ client_token: paymentMethod.clientToken });
                this._klarnaSdk.load({ container }, loadCallback);

                return this._store.getState();
            });
    }

    private _authorize(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this._klarnaSdk) {
                throw new NotInitializedError();
            }

            this._klarnaSdk.authorize({}, (res: Klarna.AuthorizationResponse) => {
                if (!res.approved) {
                    reject(res);
                } else {
                    resolve(res);
                }
            });
        });
    }
}

export interface InitializeWidgetOptions {
    container: string;
    loadCallback?: () => Klarna.LoadResponse;
}

export interface InitializeOptions extends InitializeWidgetOptions {
    paymentMethod: PaymentMethod;
}
