declare var window: any
const supportedWallets = [
    'nami',
    'eternl',
    'yoroi',
    'flint',
    'typhon',
    'gero',
]
    , getWalletApi = async namespace => {
        return await ('typhon' === namespace) ?
            window.cardano[namespace]
            :
            window.cardano[namespace].enable()
    }
    , isSupported = type => supportedWallets.includes(type)
    , hasWallet = type => isSupported(type) && window.cardano[type.toLowerCase()] !== undefined
    , getWallet = async type => await getWalletApi(type.toLowerCase())
export {
    hasWallet, getWallet
}
