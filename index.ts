import * as CSL from '@emurgo/cardano-serialization-lib-browser'
import { Address } from '@emurgo/cardano-serialization-lib-browser'
import { Buffer } from 'buffer'
import CoinSelection from './lib/coinSelection'

export const adaToLovelace = (value) => {
    return (parseFloat(value || '1') * 1000000).toFixed()
}

export const hexToBytes = (string) => {
    return Buffer.from(string, 'hex')
}

export const hexToBech32 = (address) => {
    return Address.from_bytes(hexToBytes(address)).to_bech32()
}

export const NETWORK = {
    0: 'testnet',
    1: 'mainnet',
}

export const TX = {
    too_big: 'Transaction too big',
    not_possible: 'Transaction not possible (maybe insufficient balance)',
    invalid_hereafter: 3600 * 2, //2h from current slot
}

export const supportedWallets = [
    'Nami',
    'Eternl', // ccvault
    'Yoroi',
    'Flint',
    'Typhon',
    'GeroWallet',
]

class Extension {
    type: any
    cardano: any
    constructor(type, cardano) {
        this.type = type
        this.cardano = cardano
    }

    getNetwork = async () => {
        if ('Yoroi' === this.type) {
            return NETWORK[1]
        }

        let id = await this.cardano.getNetworkId()

        if ('Typhon' === this.type) {
            id = id.data
        }

        return NETWORK[id]
    }

    getBalance = async () => {
        if ('Typhon' === this.type) {
            const response = await this.cardano.getBalance()

            return response.data.ada
        }

        const balance = await this.cardano.getBalance()

        return CSL.Value.from_bytes(hexToBytes(balance)).coin().to_str()
    }

    getChangeAddress = async () => {
        if ('Typhon' === this.type) {
            const response = await this.cardano.getAddress()

            return response.data
        }

        const changeAddress = await this.cardano.getChangeAddress()

        return hexToBech32(changeAddress)
    }

    getRewardAddress = async () => {
        if ('Typhon' === this.type) {
            const response = await this.cardano.getRewardAddress()

            return response.data
        }

        const rewardAddress = await this.cardano.getRewardAddresses()

        return hexToBech32(rewardAddress[0])
    }

    getUtxos = async () => {
        if ('Typhon' === this.type) {
            return []
        }

        const rawUtxos = await this.cardano.getUtxos()

        return rawUtxos.map((utxo) => CSL.TransactionUnspentOutput.from_bytes(hexToBytes(utxo)))
    }

    getStakeKeyHash = async () => {
        const rewardAddress = await this.getRewardAddress()

        return CSL.RewardAddress.from_address(
            CSL.Address.from_bech32(rewardAddress)
        ).payment_cred().to_keyhash().to_bytes()
    }

    signAndSubmit = async (transaction) => {
        if ('Typhon' === this.type) {
            throw 'No implementation from the extension'
        }

        try {
            const witnesses = await this.cardano.signTx(hexToBytes(transaction.to_bytes()).toString('hex'))
            const signedTx = CSL.Transaction.new(
                transaction.body(),
                CSL.TransactionWitnessSet.from_bytes(hexToBytes(witnesses))
            )

            return await this.cardano.submitTx(hexToBytes(signedTx.to_bytes()).toString('hex'))
        } catch (error) {
            //throw error.info
        }
    }


    delegateTo = async (poolId, protocolParameters = null, accountInformation = null) => {
        if ('Typhon' === this.type) {
            const { status, data, error, reason } = await this.cardano.delegationTransaction({
                poolId,
            })

            if (status) {
                return data.transactionId
            }

            throw error ?? reason
        }

        if (!protocolParameters) {
            throw 'Required protocol parameters'
        }

        if (!accountInformation) {
            throw 'Required account information'
        }

        try {
            const changeAddress = await this.getChangeAddress()
            const utxos = await this.getUtxos()
            const outputs = await prepareTx(protocolParameters.keyDeposit, changeAddress)
            const stakeKeyHash = await this.getStakeKeyHash()
            const certificates = CSL.Certificates.new()

            if (!accountInformation.active) {
                certificates.add(
                    CSL.Certificate.new_stake_registration(
                        CSL.StakeRegistration.new(
                            CSL.StakeCredential.from_keyhash(
                                CSL.Ed25519KeyHash.from_bytes(
                                    hexToBytes(stakeKeyHash)
                                )
                            )
                        )
                    )
                )
            }

            certificates.add(
                CSL.Certificate.new_stake_delegation(
                    CSL.StakeDelegation.new(
                        CSL.StakeCredential.from_keyhash(
                            CSL.Ed25519KeyHash.from_bytes(
                                hexToBytes(stakeKeyHash)
                            )
                        ),
                        CSL.Ed25519KeyHash.from_bytes(
                            hexToBytes(poolId)
                        )
                    )
                )
            )

            const transaction = await buildTx(changeAddress, utxos, outputs, protocolParameters, certificates)

            return await this.signAndSubmit(transaction)
        } catch (error) {
            throw error
        }
    }
}

const multiAssetCount = async (multiAsset) => {
    if (!multiAsset) return 0
    let count = 0
    const policies = multiAsset.keys()
    for (let j = 0; j < multiAsset.len(); j++) {
        const policy = policies.get(j)
        const policyAssets = multiAsset.get(policy)
        const assetNames = policyAssets.keys()
        for (let k = 0; k < assetNames.len(); k++) {
            count++
        }
    }
    return count
}

export const prepareTx = async (lovelaceValue, paymentAddress) => {
    const outputs = CSL.TransactionOutputs.new()

    outputs.add(
        CSL.TransactionOutput.new(
            CSL.Address.from_bech32(paymentAddress),
            CSL.Value.new(CSL.BigNum.from_str(lovelaceValue))
        )
    )

    return outputs
}

export const buildTx = async (changeAddress, utxos, outputs, protocolParameters, certificates = null) => {
    const totalAssets = await multiAssetCount(outputs.get(0).amount().multiasset())
    CoinSelection.setProtocolParameters(
        protocolParameters.minUtxo,
        protocolParameters.linearFee.minFeeA.toString(),
        protocolParameters.linearFee.minFeeB.toString(),
        protocolParameters.maxTxSize.toString()
    )

    let selection

    try {
        selection = await CoinSelection.randomImprove(utxos, outputs, 20 + totalAssets)
    } catch {
        throw TX.not_possible
    }

    const inputs = selection.input

    const txBuilder = CSL.TransactionBuilder.new(
        CSL.LinearFee.new(
            CSL.BigNum.from_str(protocolParameters.linearFee.minFeeA.toString()),
            CSL.BigNum.from_str(protocolParameters.linearFee.minFeeB.toString())
        ),
        CSL.BigNum.from_str(protocolParameters.minUtxo),
        CSL.BigNum.from_str(protocolParameters.poolDeposit),
        CSL.BigNum.from_str(protocolParameters.keyDeposit),
        protocolParameters.maxValSize,
        protocolParameters.maxTxSize
    )

    if (certificates) {
        txBuilder.set_certs(certificates)
    }

    for (let i = 0; i < inputs.length; i++) {
        const utxo = inputs[i]
        txBuilder.add_input(utxo.output().address(), utxo.input(), utxo.output().amount())
    }

    txBuilder.add_output(outputs.get(0))

    const change = selection.change
    const changeMultiAssets = change.multiasset()

    // check if change value is too big for single output
    if (changeMultiAssets && change.to_bytes().length * 2 > protocolParameters.maxValSize) {
        const partialChange = CSL.Value.new(CSL.BigNum.from_str('0'))

        const partialMultiAssets = CSL.MultiAsset.new()
        const policies = changeMultiAssets.keys()
        const makeSplit = () => {
            for (let j = 0; j < changeMultiAssets.len(); j++) {
                const policy = policies.get(j)
                const policyAssets = changeMultiAssets.get(policy)
                const assetNames = policyAssets.keys()
                const assets = CSL.Assets.new()
                for (let k = 0; k < assetNames.len(); k++) {
                    const policyAsset = assetNames.get(k)
                    const quantity = policyAssets.get(policyAsset)
                    assets.insert(policyAsset, quantity)
                    //check size
                    const checkMultiAssets = CSL.MultiAsset.from_bytes(partialMultiAssets.to_bytes())
                    checkMultiAssets.insert(policy, assets)
                    const checkValue = CSL.Value.new(CSL.BigNum.from_str('0'))
                    checkValue.set_multiasset(checkMultiAssets)
                    if (checkValue.to_bytes().length * 2 >= protocolParameters.maxValSize) {
                        partialMultiAssets.insert(policy, assets)
                        return
                    }
                }
                partialMultiAssets.insert(policy, assets)
            }
        }
        makeSplit()
        partialChange.set_multiasset(partialMultiAssets)
        const minAda = CSL.min_ada_required(partialChange, CSL.BigNum.from_str(protocolParameters.minUtxo))
        partialChange.set_coin(minAda)

        txBuilder.add_output(CSL.TransactionOutput.new(CSL.Address.from_bech32(changeAddress), partialChange))
    }

    txBuilder.set_ttl(protocolParameters.slot + TX.invalid_hereafter)
    txBuilder.add_change_if_needed(CSL.Address.from_bech32(changeAddress))

    const transaction = CSL.Transaction.new(txBuilder.build(), CSL.TransactionWitnessSet.new())

    const size = transaction.to_bytes().length * 2
    if (size > protocolParameters.maxTxSize) throw TX.too_big

    return transaction
}

declare var window: any
const getWalletApi = async (namespace) => {
    const response = await window.cardano[namespace].enable()

    if ('typhon' === namespace) {
        if (false === response.status) {
            throw response?.error ?? response.reason
        }

        return await window.cardano[namespace]
    }

    return response
}

const isSupported = type => supportedWallets.includes(type)

const hasWallet = type => (isSupported(type)) && (window.cardano[type.toLowerCase()] !== undefined)

const getWallet = async type => new Extension(type, await getWalletApi(type.toLowerCase()))

export { CSL }
export { hasWallet, getWallet }
export default Extension
