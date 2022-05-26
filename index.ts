import * as CSL from '@emurgo/cardano-serialization-lib-browser'
import { Address } from '@emurgo/cardano-serialization-lib-browser'
import { Buffer } from 'buffer'
import CoinSelection from './lib/coinSelection'

const hexToBytes = string => Buffer.from(string, 'hex'),
    hexToBech32 = address => Address.from_bytes(hexToBytes(address)).to_bech32()

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


const getRewardAddress = async wallet => {
    if ('Typhon' === wallet.type) {
        const response = await wallet.getRewardAddress()
        return response.data
    }
    const rewardAddress = await wallet.getRewardAddresses()
    return hexToBech32(rewardAddress[0])
}

const getStakeKeyHash = async wallet => {
    const rewardAddress = await getRewardAddress(wallet)
    return CSL.RewardAddress.from_address(
        CSL.Address.from_bech32(rewardAddress)
    ).payment_cred().to_keyhash().to_bytes()
}

const getChangeAddress = async wallet => {
    if ('Typhon' === wallet.type) {
        const response = await wallet.getAddress()
        return response.data
    }
    const changeAddress = await wallet.getChangeAddress()
    return hexToBech32(changeAddress)
}


const getUtxos = async wallet => {
    if ('Typhon' === wallet.type) {
        return []
    }
    const rawUtxos = await wallet.getUtxos()
    return rawUtxos.map(utxo => CSL.TransactionUnspentOutput.from_bytes(hexToBytes(utxo)))
}

const delegateTo = async (wallet, poolId, protocolParameters, accountInformation) => {
    if ('Typhon' === wallet.type) {
        const { status, data, error, reason } = await wallet.delegationTransaction({
            poolId,
        })

        if (status) {
            return data.transactionId
        }

        throw error ?? reason
    }

    try {
        const changeAddress = await getChangeAddress(wallet)
            , utxos = await getUtxos(wallet)
            , outputs = await prepareTx(protocolParameters.keyDeposit, changeAddress)
            , stakeKeyHash = await getStakeKeyHash(wallet)
            , certificates = CSL.Certificates.new()

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
            , signedTransaction = signTx(wallet, transaction)
        return await submitTx(wallet, signedTransaction)
    } catch (error) {
        throw error
    }
}
const signTx = async (wallet, transaction) => {
    await wallet.signTx(hexToBytes(transaction.to_bytes()).toString('hex')).then(witnesses =>
        CSL.Transaction.new(
            transaction.body(),
            CSL.TransactionWitnessSet.from_bytes(hexToBytes(witnesses))
        )
    )
}

const submitTx = async (wallet, signedTransaction) => await wallet.submitTx(hexToBytes(signedTransaction.to_bytes()).toString('hex'))

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
    CoinSelection.setProtocolParameters(
        protocolParameters.minUtxo,
        protocolParameters.minFeeA.toString(),
        protocolParameters.minFeeB.toString(),
        protocolParameters.maxTxSize.toString()
    )

    let selection

    try {
        selection = await CoinSelection.randomImprove(utxos, outputs, 20)
    } catch {
        throw TX.not_possible
    }

    const inputs = selection.input

    const txBuilder = CSL.TransactionBuilder.new(
        CSL.LinearFee.new(
            CSL.BigNum.from_str(protocolParameters.minFeeA.toString()),
            CSL.BigNum.from_str(protocolParameters.minFeeB.toString())
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

const getWallet = async type => await getWalletApi(type.toLowerCase())

export { CSL }
export {
    hasWallet, getWallet, getRewardAddress,
    delegateTo
}
