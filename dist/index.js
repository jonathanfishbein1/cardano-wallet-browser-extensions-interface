import { supportedWallets } from './extension';
import Extension from './extension';
import * as CSL from '@emurgo/cardano-serialization-lib-browser';
const getWalletApi = async (namespace) => {
    var _a;
    const response = await window.cardano[namespace].enable();
    if ('typhon' === namespace) {
        if (false === response.status) {
            throw (_a = response === null || response === void 0 ? void 0 : response.error) !== null && _a !== void 0 ? _a : response.reason;
        }
        return await window.cardano[namespace];
    }
    return response;
};
class Extensions {
    static isSupported(type) {
        if ('ccvault' === type) {
            type = 'Eternl';
        }
        return supportedWallets.includes(type);
    }
    static hasWallet(type) {
        var _a;
        if ('ccvault' === type) {
            type = 'Eternl';
        }
        if (!this.isSupported(type)) {
            return false;
        }
        return !!((_a = window.cardano) === null || _a === void 0 ? void 0 : _a[type.toLowerCase()]);
    }
    static async getWallet(type) {
        if (!this.isSupported(type)) {
            throw `Not supported wallet "${type}"`;
        }
        if (!this.hasWallet(type)) {
            throw `Not available wallet "${type}"`;
        }
        const namespace = type.toLowerCase();
        const object = `${namespace}Object`;
        if (undefined === this[object]) {
            try {
                this[object] = new Extension(type, await getWalletApi(namespace));
            }
            catch (error) {
                // throw typeof error === 'string' ? error : (error.info || error.message || 'user abort connection')
            }
        }
        return Object.freeze(this[object]);
    }
}
Extensions.supported = supportedWallets;
export default Extensions;
export { CSL };
