import * as CSL from '@emurgo/cardano-serialization-lib-browser'
import { Address } from '@emurgo/cardano-serialization-lib-browser'
import { Buffer } from 'buffer'
import CoinSelection from './lib/coinSelection'

const hexToBytes = string => Buffer.from(string, 'hex'),
    hexToBech32 = address => Address.from_bytes(hexToBytes(address)).to_bech32()

const TX = {
    too_big: 'Transaction too big'
}

const supportedWallets = [
    'nami',
    'eternl',
    'yoroi',
    'flint',
    'typhon',
    'gero',
]


const getRewardAddress = async wallet => {
    return await ('Typhon Wallet' === wallet.name) ?
        wallet.getRewardAddress().then(response => response.data)
        :
        wallet.getRewardAddresses().then(rewardAddress => hexToBech32(rewardAddress[0]))
}

const getStakeKeyHash = async wallet => {
    const rewardAddress = await getRewardAddress(wallet)
    return CSL.RewardAddress.from_address(
        CSL.Address.from_bech32(rewardAddress)
    )?.payment_cred().to_keyhash()?.to_bytes()
}

const getChangeAddress = async wallet => {
    return await ('Typhon Wallet' === wallet.name) ?
        wallet.getAddress().then(response => response.data)
        :
        wallet.getChangeAddress().then(changeAddress => hexToBech32(changeAddress))
}


const getUtxos = async wallet => {
    return await ('Typhon Wallet' === wallet.name) ?
        []
        :
        wallet.getUtxos().then(rawUtxos => rawUtxos.map(utxo => CSL.TransactionUnspentOutput.from_bytes(hexToBytes(utxo))))
}

const delegateTo = async (wallet, poolId, protocolParameters, account) => {
    if ('Typhon Wallet' === wallet.name) {
        const { status, data, error, reason } = await wallet.delegationTransaction({
            poolId,
        })
        return status ? data.transactionId : { error, reason }
    }
    else {
        const changeAddress = await getChangeAddress(wallet)
            , utxos = await getUtxos(wallet)
            , outputs = CSL.TransactionOutputs.new()
        outputs.add(
            CSL.TransactionOutput.new(
                CSL.Address.from_bech32(changeAddress),
                CSL.Value.new(CSL.BigNum.from_str(protocolParameters.keyDeposit))
            )
        )
        const stakeKeyHash = await getStakeKeyHash(wallet)
            , certificates = CSL.Certificates.new()
            , stakeCredential = CSL.StakeCredential.from_keyhash(
                CSL.Ed25519KeyHash.from_bytes(
                    hexToBytes(stakeKeyHash)
                )
            )
            , poolKeyHash = CSL.Ed25519KeyHash.from_bytes(
                hexToBytes(poolId)
            )
            , stakeDelegation = CSL.StakeDelegation.new(
                stakeCredential,
                poolKeyHash
            )
            , certificate = CSL.Certificate.new_stake_delegation(
                stakeDelegation
            )
        if (!account.active) {
            certificates.add(
                CSL.Certificate.new_stake_registration(
                    CSL.StakeRegistration.new(
                        stakeCredential
                    )
                )
            )
            certificates.add(certificate)
        }
        else
            certificates.add(certificate)

        const transaction = await buildTx(changeAddress, utxos, outputs, protocolParameters, certificates)
            , signedTransaction = await signTx(wallet, transaction)
        return await submitTx(wallet, signedTransaction)
    }
}
const signTx = async (wallet, transaction) => {
    return wallet.signTx(hexToBytes(transaction.to_bytes()).toString('hex')).then(witnesses => {
        return CSL.Transaction.new(
            transaction.body(),
            CSL.TransactionWitnessSet.from_bytes(hexToBytes(witnesses))
        )
    }
    )
}


const submitTx = async (wallet, signedTransaction) => await wallet.submitTx(hexToBytes(signedTransaction.to_bytes()).toString('hex'))

export const buildTx = async (changeAddress, utxos, outputs, protocolParameters, certificates) => {
    CoinSelection.setProtocolParameters(
        protocolParameters.minUtxo,
        protocolParameters.minFeeA.toString(),
        protocolParameters.minFeeB.toString(),
        protocolParameters.maxTxSize.toString()
    )
    const selection = await CoinSelection.randomImprove(utxos, outputs, 20)
        , inputs = selection.input
        , txBuilder = CSL.TransactionBuilder.new(
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
    if (certificates)
        txBuilder.set_certs(certificates)
    inputs.map(utxo => txBuilder.add_input(utxo.output().address(), utxo.input(), utxo.output().amount()))
    txBuilder.add_output(outputs.get(0))
    const change = selection.change
        , changeMultiAssets = change.multiasset()
    if (changeMultiAssets && change.to_bytes().length * 2 > protocolParameters.maxValSize) {
        const partialChange = CSL.Value.new(CSL.BigNum.from_str('0'))
            , partialMultiAssets = CSL.MultiAsset.new()
            , policies = changeMultiAssets.keys()
        policies.map(policy => {
            const policyAssets = changeMultiAssets.get(policy)
                , assetNames = policyAssets.keys()
                , assets = CSL.Assets.new()
            assetNames.map(policyAsset => {
                const quantity = policyAssets.get(policyAsset)
                assets.insert(policyAsset, quantity)
                const checkMultiAssets = CSL.MultiAsset.from_bytes(partialMultiAssets.to_bytes())
                checkMultiAssets.insert(policy, assets)
                const checkValue = CSL.Value.new(CSL.BigNum.from_str('0'))
                checkValue.set_multiasset(checkMultiAssets)
                if (checkValue.to_bytes().length * 2 >= protocolParameters.maxValSize)
                    partialMultiAssets.insert(policy, assets)
            })
            partialMultiAssets.insert(policy, assets)
        }
        )
        partialChange.set_multiasset(partialMultiAssets)
        const minAda = CSL.min_ada_required(partialChange, CSL.BigNum.from_str(protocolParameters.minUtxo))
        partialChange.set_coin(minAda)
        txBuilder.add_output(CSL.TransactionOutput.new(CSL.Address.from_bech32(changeAddress), partialChange))
    }
    txBuilder.add_change_if_needed(CSL.Address.from_bech32(changeAddress))
    const transaction = CSL.Transaction.new(txBuilder.build(), CSL.TransactionWitnessSet.new())
        , size = transaction.to_bytes().length * 2
    if (size > protocolParameters.maxTxSize) throw TX.too_big
    return transaction
}

declare var window: any
const getWalletApi = async namespace => {
    return await ('typhon' === namespace) ?
        window.cardano[namespace]
        :
        window.cardano[namespace].enable()
}


const isSupported = type => supportedWallets.includes(type)

const hasWallet = type => isSupported(type) && window.cardano[type.toLowerCase()] !== undefined

const getWallet = async type => await getWalletApi(type.toLowerCase())

export { CSL }
export {
    hasWallet, getWallet, getRewardAddress,
    delegateTo
}
